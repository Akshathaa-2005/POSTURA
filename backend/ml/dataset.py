"""Recordings -> training samples, with augmentation that mimics what real cameras and bodies vary."""

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

from ml import skeleton as sk
from ml.vocab import EXERCISE_IDS, EXERCISE_MASK, FAULTS

FAULT_INDEX = {f: i for i, f in enumerate(FAULTS)}
EX_INDEX = {e: i for i, e in enumerate(EXERCISE_IDS)}
WEAK_WEIGHT = 0.3  # rule-engine labels are noisier than a person's label


@dataclass
class Rep:
    exercise: int
    joints: np.ndarray  # (F, V, 3)
    context: np.ndarray  # (F, 3)
    target: np.ndarray  # (N_FAULTS,)
    mask: np.ndarray  # (N_FAULTS,) which outputs this exercise defines
    weight: float
    session: str
    rules: np.ndarray | None  # rule-engine labels, for the model-vs-rules comparison
    reviewed: bool


def _labels(ids: list[str], exercise_id: str) -> np.ndarray:
    y = np.zeros(len(FAULTS), dtype=np.float32)
    for f in ids:
        key = f"{exercise_id}:{f}"
        if key in FAULT_INDEX:
            y[FAULT_INDEX[key]] = 1.0
    return y


def load_recordings(path: Path, use_weak: bool = False) -> list[Rep]:
    """Reads every *.json file under `path`. Unreviewed reps (rule labels only) are kept only with use_weak."""
    reps: list[Rep] = []
    for file in sorted(Path(path).rglob("*.json")):
        blob = json.loads(file.read_text())
        items = blob if isinstance(blob, list) else blob.get("reps", [blob])
        for r in items:
            if r.get("spec_version", 1) != sk.SPEC["version"] or r["exercise_id"] not in EX_INDEX:
                continue
            if r.get("kind", "rep") != "rep" or len(r["frames"]) < 8:
                continue
            labels = r.get("labels", {})
            reviewed = bool(labels.get("reviewed"))
            if not reviewed and not use_weak:
                continue
            ids = labels.get("manual") if reviewed else labels.get("rules", [])
            ex = EX_INDEX[r["exercise_id"]]
            reps.append(
                Rep(
                    exercise=ex,
                    joints=np.asarray(r["frames"], dtype=np.float32).reshape(len(r["frames"]), sk.V, 3),
                    context=np.asarray(r["context"], dtype=np.float32),
                    target=_labels(ids or [], r["exercise_id"]),
                    mask=np.asarray(EXERCISE_MASK[ex], dtype=np.float32),
                    weight=1.0 if reviewed else WEAK_WEIGHT,
                    session=str(r.get("user") or r.get("session") or file.stem),
                    rules=_labels(labels["rules"], r["exercise_id"]) if "rules" in labels else None,
                    reviewed=reviewed,
                )
            )
    return reps


def split_by_session(reps: list[Rep], val_fraction: float = 0.2, seed: int = 0) -> tuple[list[Rep], list[Rep]]:
    """Whole sessions go to one side, so a person's reps never appear in both train and validation."""
    sessions = sorted({r.session for r in reps})
    rng = np.random.default_rng(seed)
    rng.shuffle(sessions)
    n_val = max(1, round(len(sessions) * val_fraction)) if len(sessions) > 1 else 0
    val = set(sessions[:n_val])
    return [r for r in reps if r.session not in val], [r for r in reps if r.session in val]


def augment(joints: np.ndarray, context: np.ndarray, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    f = joints.shape[0]
    a = int(rng.integers(0, max(1, int(0.08 * f)) + 1))  # start a little late
    b = f - int(rng.integers(0, max(1, int(0.08 * f)) + 1))  # end a little early
    if b - a >= 8:
        joints, context = joints[a:b], context[a:b]
    j = joints.copy()
    if rng.random() < 0.5:
        j = sk.mirror(j)
    sx, sy = rng.uniform(0.9, 1.1, size=2)  # body proportions / perspective
    ang = math.radians(rng.uniform(-8, 8))
    c, s = math.cos(ang), math.sin(ang)
    x, y = j[..., 0] * sx, j[..., 1] * sy
    j[..., 0], j[..., 1] = c * x - s * y, s * x + c * y
    j[..., :2] += rng.normal(0, 0.01, size=j[..., :2].shape)
    drop = rng.random(sk.V) < 0.04  # a joint the pose model lost for the whole rep
    j[:, drop, 2] = 0.1
    j[:, drop, :2] += rng.normal(0, 0.25, size=(1, int(drop.sum()), 2))
    return j, context


class RepDataset(Dataset):
    def __init__(self, reps: list[Rep], train: bool, seed: int = 0):
        self.reps, self.train = reps, train
        self.rng = np.random.default_rng(seed)

    def __len__(self) -> int:
        return len(self.reps)

    def __getitem__(self, i: int):
        r = self.reps[i]
        j, c = (augment(r.joints, r.context, self.rng) if self.train else (r.joints, r.context))
        j = sk.resample(j.reshape(len(j), -1), sk.T).reshape(sk.T, sk.V, 3)
        c = sk.resample(c, sk.T)
        return (
            torch.from_numpy(sk.to_model_input(j, c)),
            torch.tensor(r.exercise),
            torch.from_numpy(r.target),
            torch.from_numpy(r.mask),
            torch.tensor(r.weight, dtype=torch.float32),
        )
