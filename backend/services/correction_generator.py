"""Turns detected faults into spoken coaching, using a local Ollama LLM with authored cues as the fallback.

The LLM is never asked to diagnose anything — the fault (what's wrong and how to fix it) comes from
the exercise database. It only rephrases the authored cue so the coach sounds natural and varied.
"""

import itertools
import logging
import random
import re
from typing import Any, Literal

import httpx

from config import get_settings
from models import Measurement
from schemas.avatar import (
    AvatarCorrectionCommand,
    BoneTransform,
    KinematicClamper,
    Vector3D,
    get_canonical_correction,
)

log = logging.getLogger(__name__)

Source = Literal["llm", "template", "cache"]

# Distinct phrasings per (exercise, fault, side, status); rotated so repeats don't sound robotic.
VARIANTS_PER_CUE = 3
CueKey = tuple[str, str, str | None, str, str]
_variants: dict[CueKey, list[str]] = {}
_rotation: dict[CueKey, itertools.cycle] = {}
MODEL_CONFIRMS = 0.6  # form-model probability at which the LLM is told the model agrees with the rule


SYSTEM_PROMPT = """You are Postura, a calm and encouraging personal trainer speaking to someone mid-workout.
You rephrase an expert's correction cue into one short sentence that will be read aloud.

Rules:
- One sentence, at most 16 words, easy to say in one breath.
- Keep the expert cue's exact meaning, body parts and side (left/right). Never add new advice.
- Say what to do, not what went wrong. Use "you"/imperatives, warm but direct.
- Plain words: no numbers or degrees, no jargon, no quotes, no emojis, no greetings.
- If a "Measured" line is given, let it set the intensity: a small nudge when just past the limit, a firmer push when far past it. Never mention the measurement itself.

Examples:
Exercise: Push-Up · Problem right now: Hips sagging (significant)
Expert cue: Lift your hips — squeeze your glutes and brace your core
Coach: Squeeze your glutes and lift those hips into a strong straight line.

Exercise: Bodyweight Squat · Problem on the last rep: Not deep enough (minor)
Expert cue: Sink a little deeper — aim for thighs parallel to the floor
Coach: Next one, sit a touch deeper until your thighs are level with the floor.

Exercise: Jumping Jack · Problem on the last rep: Arms not overhead (minor)
Expert cue: Your left arm isn't reaching overhead — swing it all the way up
Coach: Reach that left arm all the way up overhead on the next jump."""


def describe_deviation(m: Measurement) -> tuple[str, str]:
    """Turns a metric reading into words plus a bucket, so the LLM never does arithmetic on raw numbers.

    Returns e.g. ("hip is too low, far past the limit", "far"); the bucket also keys the phrasing cache.
    """
    below = m.op == "<"
    gap = (m.warn - m.value) if below else (m.value - m.warn)
    span = abs(m.warn - m.bad) if m.bad is not None else abs(m.warn) or 1.0
    ratio = max(gap, 0.0) / span if span else 0.0
    bucket = "far" if ratio >= 1.0 else "clear" if ratio >= 0.5 else "near"
    how = {"near": "just past the limit", "clear": "clearly past the limit", "far": "far past the limit"}[bucket]
    return f"{m.metric.replace('_', ' ')} is too {'low' if below else 'high'}, {how}", bucket


def build_prompt(
    exercise: dict[str, Any],
    label: str,
    cue: str,
    status: str,
    from_rep: bool,
    avoid: list[str],
    measured: str | None = None,
    model_agrees: bool = False,
) -> str:
    when = "on the last rep" if from_rep else "right now"
    severity = "significant" if status == "bad" else "minor"
    avoid_text = "".join(f"\n- {a}" for a in avoid)
    return (
        f"Exercise: {exercise['name']} · Problem {when}: {label} ({severity})\n"
        + (f"Measured: {measured}\n" if measured else "")
        + ("Movement model: also flagged this rep\n" if model_agrees else "")
        + f"Expert cue: {cue}\n"
        + (f"Use different wording from these earlier lines:{avoid_text}\n" if avoid else "")
        + "Coach:"
    )


def _clean(text: str) -> str:
    # Models often wrap replies in quotes or echo the "Coach:" label; drop both.
    text = re.sub(r"\s+", " ", re.sub(r'["“”]', "", text)).strip()
    text = re.sub(r"^coach:\s*", "", text, flags=re.IGNORECASE)
    first = re.split(r"(?<=[.!?])\s+", text)[0]
    return first if len(first.split()) <= 24 else ""


async def ollama_available() -> bool:
    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{s.ollama_api_url}/api/tags")
            r.raise_for_status()
            names = [m.get("name", "") for m in r.json().get("models", [])]
            return any(n.split(":")[0] == s.ollama_model.split(":")[0] for n in names)
    except (httpx.HTTPError, ValueError):
        return False


async def _generate(system: str, prompt: str, num_predict: int, stop: list[str] | None = None) -> str:
    s = get_settings()
    async with httpx.AsyncClient(timeout=s.llm_timeout_sec) as client:
        r = await client.post(
            f"{s.ollama_api_url}/api/generate",
            json={
                "model": s.ollama_model,
                "system": system,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.7, "num_predict": num_predict, **({"stop": stop} if stop else {})},
            },
        )
        r.raise_for_status()
        return r.json().get("response", "")


async def _ask_llm(prompt: str) -> str:
    return _clean(await _generate(SYSTEM_PROMPT, prompt, 48, ["\n"]))


async def generate_correction(
    exercise: dict[str, Any],
    fault_id: str,
    label: str,
    cue: str,
    status: str,
    side: str | None = None,
    from_rep: bool = False,
    measurement: Measurement | None = None,
    model_prob: float | None = None,
) -> tuple[str, Source]:
    measured, bucket = describe_deviation(measurement) if measurement else (None, "-")
    model_agrees = model_prob is not None and model_prob >= MODEL_CONFIRMS
    key = (exercise["id"], fault_id, side, status, bucket)
    known = _variants.setdefault(key, [])

    if len(known) >= VARIANTS_PER_CUE:
        return next(_rotation.setdefault(key, itertools.cycle(known))), "cache"

    try:
        text = await _ask_llm(build_prompt(exercise, label, cue, status, from_rep, known, measured, model_agrees))
        if text and text not in known:
            known.append(text)
            _rotation.pop(key, None)
            return text, "llm"
    except (httpx.HTTPError, ValueError) as exc:
        log.info("Ollama unavailable (%s); using the authored cue", exc.__class__.__name__)

    if known:
        return random.choice(known), "cache"
    return cue if cue.endswith((".", "!", "?")) else f"{cue}.", "template"


def generate_avatar_command(
    exercise: dict[str, Any],
    fault_id: str,
    verbal_cue: str,
    side: str | None = None,
) -> AvatarCorrectionCommand:
    """Produces a kinematically validated avatar command for the detected exercise fault."""
    data = get_canonical_correction(exercise.get("id") if exercise else None, fault_id)
    if not data:
        # Default subtle posture adjustment on Spine
        data = {
            "highlight_joints": ["Spine"],
            "actions": [
                {
                    "bone_name": "Spine",
                    "rotation_mode": "relative_offset",
                    "target_rotation": {"x": -8.0, "y": 0.0, "z": 0.0},
                    "duration_ms": 600,
                    "easing": "easeInOutQuad",
                }
            ],
        }

    highlight_joints = list(data.get("highlight_joints", []))
    actions: list[BoneTransform] = []

    for item in data.get("actions", []):
        bone = item["bone_name"]
        # If a specific side is flagged, filter or re-target unilateral limbs
        if side:
            prefix = "Left" if side == "left" else "Right"
            opp_prefix = "Right" if side == "left" else "Left"
            if bone.startswith(opp_prefix):
                continue

        rot = item["target_rotation"]
        action = BoneTransform(
            bone_name=bone,
            rotation_mode=item.get("rotation_mode", "relative_offset"),
            target_rotation=Vector3D(x=rot["x"], y=rot["y"], z=rot["z"]),
            duration_ms=item.get("duration_ms", 800),
            easing=item.get("easing", "easeInOutQuad"),
        )
        actions.append(action)

    if side:
        prefix = "Left" if side == "left" else "Right"
        highlight_joints = [
            j for j in highlight_joints
            if not (j.startswith("Left") or j.startswith("Right")) or j.startswith(prefix)
        ]

    cmd = AvatarCorrectionCommand(
        verbal_cue=verbal_cue,
        primary_fault=fault_id,
        highlight_joints=highlight_joints,
        avatar_actions=actions,
    )
    return KinematicClamper.sanitize(cmd)


def encouragement(exercise: dict[str, Any]) -> str:
    return random.choice(exercise.get("voice_encouragement") or ["Great work!"])


SUMMARY_SYSTEM = """You are Postura, a calm and encouraging personal trainer writing a short debrief after a workout.
Write 2 or 3 plain sentences, at most 60 words, speaking to the person as "you".
Rules:
- Use only the facts given. Do not invent numbers, exercises or problems.
- Say what went well first, then the one or two things to focus on next time, as actions.
- No medical advice, no emojis, no headings, no lists."""


def summary_facts(exercise: dict[str, Any], digest: dict[str, Any]) -> str:
    hold = exercise.get("mode") == "hold"
    done = f"{digest['reps']} seconds held" if hold else f"{digest['reps']} of {digest['rep_target']} reps"
    lines = [f"Exercise: {exercise['name']}", f"Completed: {done}"]
    if digest.get("partial_reps"):
        lines.append(f"Partial reps (not counted): {digest['partial_reps']}")
    if digest.get("avg_score") is not None:
        lines.append(f"Average form score: {round(digest['avg_score'])} out of 100")
    if digest["faults"]:
        lines.append("Form problems coached, most frequent first: " + ", ".join(f"{label} (x{n})" for label, n in digest["faults"]))
    else:
        lines.append("Form problems coached: none")
    return "\n".join(lines)


def template_summary(exercise: dict[str, Any], digest: dict[str, Any]) -> str:
    hold = exercise.get("mode") == "hold"
    done = f"{digest['reps']} seconds" if hold else f"{digest['reps']} reps"
    text = f"Nice work on {exercise['name'].lower()}: {done} done."
    if digest["faults"]:
        text += f" Next time, focus on fixing: {digest['faults'][0][0].lower()}."
    else:
        text += " Your form held up well throughout."
    return text


async def generate_summary(exercise: dict[str, Any], digest: dict[str, Any]) -> tuple[str, Source]:
    """A short LLM debrief grounded in the session's CV-derived stats; the template is the fallback."""
    try:
        text = re.sub(r"\s+", " ", await _generate(SUMMARY_SYSTEM, summary_facts(exercise, digest) + "\nDebrief:", 120)).strip()
        if text and len(text.split()) <= 80:
            return text, "llm"
    except (httpx.HTTPError, ValueError) as exc:
        log.info("Ollama unavailable (%s); using the template summary", exc.__class__.__name__)
    return template_summary(exercise, digest), "template"
