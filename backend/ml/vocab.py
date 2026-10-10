"""The model's output vocabulary: one logit per (exercise, fault) pair from exercises/exercises.json."""

import json
from pathlib import Path

EXERCISES_PATH = Path(__file__).resolve().parents[2] / "exercises" / "exercises.json"


def load():
    data = json.loads(EXERCISES_PATH.read_text())
    exercise_ids = list(data)
    faults: list[str] = []
    mask = []
    for eid in exercise_ids:
        ids = [f"{eid}:{f['id']}" for f in data[eid]["faults"]]
        faults += ids
    for eid in exercise_ids:
        own = {f"{eid}:{f['id']}" for f in data[eid]["faults"]}
        mask.append([1.0 if f in own else 0.0 for f in faults])
    return exercise_ids, faults, mask, data


EXERCISE_IDS, FAULTS, EXERCISE_MASK, EXERCISES = load()
N_EXERCISES = len(EXERCISE_IDS)
N_FAULTS = len(FAULTS)
