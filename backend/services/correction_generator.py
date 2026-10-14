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
from schemas.avatar import (
    AvatarCorrectionCommand,
    BoneTransform,
    CANONICAL_AVATAR_CORRECTIONS,
    KinematicClamper,
    Vector3D,
)

log = logging.getLogger(__name__)

Source = Literal["llm", "template", "cache"]

# Distinct phrasings per (exercise, fault, side, status); rotated so repeats don't sound robotic.
VARIANTS_PER_CUE = 3
_variants: dict[tuple[str, str, str | None, str], list[str]] = {}
_rotation: dict[tuple[str, str, str | None, str], itertools.cycle] = {}


SYSTEM_PROMPT = """You are Postura, a calm and encouraging personal trainer speaking to someone mid-workout.
You rephrase an expert's correction cue into one short sentence that will be read aloud.

Rules:
- One sentence, at most 16 words, easy to say in one breath.
- Keep the expert cue's exact meaning, body parts and side (left/right). Never add new advice.
- Say what to do, not what went wrong. Use "you"/imperatives, warm but direct.
- Plain words: no numbers or degrees, no jargon, no quotes, no emojis, no greetings.

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


def build_prompt(exercise: dict[str, Any], label: str, cue: str, status: str, from_rep: bool, avoid: list[str]) -> str:
    when = "on the last rep" if from_rep else "right now"
    severity = "significant" if status == "bad" else "minor"
    avoid_text = "".join(f"\n- {a}" for a in avoid)
    return (
        f"Exercise: {exercise['name']} · Problem {when}: {label} ({severity})\n"
        f"Expert cue: {cue}\n"
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


async def _ask_llm(prompt: str) -> str:
    s = get_settings()
    async with httpx.AsyncClient(timeout=s.llm_timeout_sec) as client:
        r = await client.post(
            f"{s.ollama_api_url}/api/generate",
            json={
                "model": s.ollama_model,
                "system": SYSTEM_PROMPT,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.7, "num_predict": 48, "stop": ["\n"]},
            },
        )
        r.raise_for_status()
        return _clean(r.json().get("response", ""))


async def generate_correction(
    exercise: dict[str, Any],
    fault_id: str,
    label: str,
    cue: str,
    status: str,
    side: str | None = None,
    from_rep: bool = False,
) -> tuple[str, Source]:
    key = (exercise["id"], fault_id, side, status)
    known = _variants.setdefault(key, [])

    if len(known) >= VARIANTS_PER_CUE:
        return next(_rotation.setdefault(key, itertools.cycle(known))), "cache"

    try:
        text = await _ask_llm(build_prompt(exercise, label, cue, status, from_rep, known))
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
    data = CANONICAL_AVATAR_CORRECTIONS.get(fault_id)
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
