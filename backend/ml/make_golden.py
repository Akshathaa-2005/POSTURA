"""Writes backend/ml/fixtures/normalize_golden.json: random (seeded) landmark sequences with the expected
normalised features. Both the Python and the TypeScript implementations are tested against it."""

import json
from pathlib import Path

import numpy as np

from ml import skeleton as sk

OUT = Path(__file__).parent / "fixtures" / "normalize_golden.json"


def make_sequence(rng: np.random.Generator, frames: int = 14) -> np.ndarray:
    base = rng.uniform(0.2, 0.8, size=(33, 2))
    drift = rng.normal(0, 0.03, size=(33, 2))
    seq = np.zeros((frames, 33, 3))
    for t in range(frames):
        seq[t, :, :2] = base + drift * np.sin(t / frames * np.pi)
        seq[t, :, 2] = rng.uniform(0.6, 1.0, size=33)
    seq[0, :, 2] = 0.1  # torso unseen on the very first frame -> everything zero
    seq[5, [11, 12, 23, 24], 2] = 0.1  # torso lost mid-sequence -> previous transform reused
    seq[:, :, :2] = np.round(seq[:, :, :2], 6)
    seq[:, :, 2] = np.round(seq[:, :, 2], 6)
    return seq


def main() -> None:
    rng = np.random.default_rng(1234)
    cases = []
    for width, height in ((1280, 720), (640, 480)):
        seq = make_sequence(rng)
        joints, context = sk.normalize_sequence(list(seq), width, height)
        res_j = sk.resample(joints.reshape(len(joints), -1), sk.T)
        res_c = sk.resample(context, sk.T)
        model_in = sk.to_model_input(res_j.reshape(sk.T, sk.V, 3), res_c)
        cases.append(
            {
                "width": width,
                "height": height,
                "frames": seq.tolist(),
                "joints": joints.tolist(),
                "context": context.tolist(),
                "resampled_joints": res_j.tolist(),
                "model_input": model_in.reshape(-1).tolist(),
            }
        )
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"spec_version": sk.SPEC["version"], "cases": cases}))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
