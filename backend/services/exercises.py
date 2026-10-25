"""Loads the shared exercise database (../exercises/exercises.json), also used by the frontend."""

import json
from functools import lru_cache
from typing import Any

from config import get_settings


@lru_cache
def load_exercises() -> dict[str, dict[str, Any]]:
    with open(get_settings().exercises_path, encoding="utf-8") as f:
        data = json.load(f)
    return {eid: {"id": eid, **e} for eid, e in data.items()}


def get_exercise(exercise_id: str) -> dict[str, Any] | None:
    return load_exercises().get(exercise_id)


# Problems the browser reports that aren't rules in exercises.json: framing and tempo. The browser sends the exact
# wording it shows (it depends on the exercise), so what is spoken matches the screen; these are the fallbacks.
SYNTHETIC_FAULTS: dict[str, dict[str, str]] = {
    "framed": {"label": "Can't see you", "cue": "Step back so your whole body is in frame"},
    "unseen": {"label": "Can't see you", "cue": "Step back so your whole body is in frame"},
    "lost": {"label": "Left the frame", "cue": "Stay fully in frame for the whole rep"},
    "rushed": {"label": "Too fast", "cue": "Slow down and control the movement"},
    "start": {"label": "Start position", "cue": "Start from the proper starting position"},
    "stalled": {"label": "Not smooth", "cue": "Keep one smooth motion, don't stop or bounce midway"},
}


def get_fault(exercise: dict[str, Any], fault_id: str) -> dict[str, Any] | None:
    """A fault rule by id; "setup" is the exercise's starting-position hint."""
    if fault_id == "setup" and exercise.get("setup"):
        return {"id": "setup", "label": "Get into position", "cue": exercise["setup"]["cue"]}
    if fault_id == "view":
        return {"id": "view", "label": "Wrong angle", "cue": exercise["camera_setup"]}
    if fault_id in SYNTHETIC_FAULTS:
        return {"id": fault_id, **SYNTHETIC_FAULTS[fault_id]}
    return next((f for f in exercise.get("faults", []) if f["id"] == fault_id), None)


def fault_cue(exercise: dict[str, Any], fault: dict[str, Any], side: str | None) -> str:
    """The authored cue; front-view exercises name the side when only one side is at fault."""
    if side and exercise.get("view") == "front" and fault.get("cue_side"):
        return fault["cue_side"].replace("{side}", side)
    return fault["cue"]
