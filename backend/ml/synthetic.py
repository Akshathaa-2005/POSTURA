"""SYNTHETIC reps for smoke-testing the pipeline (train -> export -> quantise -> browser).

Built by interpolating each exercise's reference keyframes; the only fault it can fake is the depth/range one
(a rep that stops short). A model trained on this has NOT learned real form: never ship it, and never read
its accuracy as evidence about real users. Real data comes from the app's Record mode.
"""

import json
import math
from pathlib import Path

import numpy as np

from ml import skeleton as sk
from ml.vocab import EXERCISES, EXERCISE_IDS

FIGURES = json.loads((Path(__file__).resolve().parents[2] / "exercises" / "figure_poses.json").read_text())
OUT = Path(__file__).parent / "data" / "synthetic"


def depth_fault(ex: dict) -> str | None:
    """The rep-level fault on the rep's own metric (e.g. shallow_squat), if the exercise has one."""
    rep = ex.get("rep")
    if not rep:
        return None
    for f in ex["faults"]:
        if f["when"] == "rep" and f["metric"] == rep["metric"]:
            return f["id"]
    return None


def figure_to_landmarks(fig: dict[str, list[float]]) -> np.ndarray:
    """13-point reference figure -> (33, 3) MediaPipe-style landmarks in a 100x124 image space."""
    lm = np.zeros((33, 3))
    lm[:, 2] = 0.95
    def put(i, k):
        lm[i, :2] = fig[k]
    put(0, "head"); put(11, "lS"); put(12, "rS"); put(13, "lE"); put(14, "rE"); put(15, "lW"); put(16, "rW")
    put(23, "lH"); put(24, "rH"); put(25, "lK"); put(26, "rK"); put(27, "lA"); put(28, "rA")
    for side, ank in ((29, 27), (30, 28)):
        lm[side, :2] = lm[ank, :2] + (-4, 2)
    for side, ank in ((31, 27), (32, 28)):
        lm[side, :2] = lm[ank, :2] + (9, 2)
    return lm


def make_rep(eid: str, depth: float, rng: np.random.Generator) -> dict:
    a, b = (figure_to_landmarks(f) for f in FIGURES[eid])
    frames = int(rng.integers(35, 90))
    w, h = 1280, 720
    scale = rng.uniform(2.2, 4.5)  # distance from the camera
    roll = math.radians(rng.uniform(-15, 15))
    off = np.array([rng.uniform(0.35, 0.65) * w, rng.uniform(0.45, 0.6) * h])
    raw = []
    for t in range(frames):
        p = depth * math.sin(math.pi * t / (frames - 1)) ** 2
        lm = a + p * (b - a)
        lm[:, :2] += rng.normal(0, 0.35, size=(33, 2))
        xy = (lm[:, :2] - [50, 62]) * scale
        c, s = math.cos(roll), math.sin(roll)
        xy = np.stack([c * xy[:, 0] - s * xy[:, 1], s * xy[:, 0] + c * xy[:, 1]], axis=1) + off
        out = lm.copy()
        out[:, 0], out[:, 1] = xy[:, 0] / w, xy[:, 1] / h
        raw.append(out)
    joints, context = sk.normalize_sequence(raw, w, h)
    return {"frames": np.round(joints, 4).tolist(), "context": np.round(context, 4).tolist()}


def generate(per_exercise: int = 48, sessions: int = 8, seed: int = 0, out: Path = OUT) -> int:
    rng = np.random.default_rng(seed)
    out.mkdir(parents=True, exist_ok=True)
    count = 0
    for s in range(sessions):
        reps = []
        for eid in EXERCISE_IDS:
            fault = depth_fault(EXERCISES[eid])
            if fault is None or EXERCISES[eid].get("mode") == "hold":
                continue
            for _ in range(per_exercise // sessions):
                shallow = rng.random() < 0.5
                depth = rng.uniform(0.4, 0.78) if shallow else rng.uniform(0.92, 1.05)
                reps.append(
                    {
                        "version": 1, "spec_version": 1, "kind": "rep", "exercise_id": eid, "session": f"synthetic-{s}",
                        "labels": {"manual": [fault] if shallow else [], "rules": [], "reviewed": True},
                        **make_rep(eid, depth, rng),
                    }
                )
                count += 1
        (out / f"synthetic-{s}.json").write_text(json.dumps({"reps": reps}))
    return count


if __name__ == "__main__":
    print("wrote", generate(), "synthetic reps to", OUT)
