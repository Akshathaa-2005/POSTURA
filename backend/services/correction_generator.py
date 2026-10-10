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

log = logging.getLogger(__name__)

Source = Literal["llm", "template", "cache"]

# Distinct phrasings per (exercise, fault, side, status); rotated so repeats don't sound robotic.
VARIANTS_PER_CUE = 3
_variants: dict[tuple[str, str, str | None, str], list[str]] = {}
_rotation: dict[tuple[str, str, str | None, str], itertools.cycle] = {}


def build_prompt(exercise: dict[str, Any], label: str, cue: str, status: str, from_rep: bool, avoid: list[str]) -> str:
    when = "on their last rep" if from_rep else "right now"
    urgency = "This is a significant form problem." if status == "bad" else "This is a minor adjustment."
    avoid_text = "".join(f"\n- {a}" for a in avoid)
    return (
        "You are a warm, encouraging personal trainer giving short spoken cues during a workout.\n"
        f"Exercise: {exercise['name']}.\n"
        f"Problem {when}: {label}. {urgency}\n"
        f"Expert cue: \"{cue}\"\n\n"
        "Rephrase the expert cue as ONE spoken sentence of at most 16 words. Keep its exact meaning and "
        "body parts (including left/right). Be specific and positive; tell them what to do, not what they did wrong. "
        "No greetings, no quotes, no emojis."
        + (f"\nDon't repeat these earlier phrasings:{avoid_text}" if avoid else "")
    )


def _clean(text: str) -> str:
    # Models often wrap replies in quotes; drop them so sentence splitting works.
    text = re.sub(r"\s+", " ", re.sub(r'["“”]', "", text)).strip()
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
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.7, "num_predict": 48},
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


def encouragement(exercise: dict[str, Any]) -> str:
    return random.choice(exercise.get("voice_encouragement") or ["Great work!"])
