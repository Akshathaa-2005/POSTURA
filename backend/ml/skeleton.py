"""Skeleton normalisation shared (by spec) with the browser: frontend/src/ml/skeleton.ts.

Any change here must be mirrored there; tests/test_ml_parity.py and src/ml/skeleton.test.ts both check
the golden file backend/ml/fixtures/normalize_golden.json.
"""

import json
import math
from pathlib import Path

import numpy as np

SPEC_PATH = Path(__file__).resolve().parents[2] / "exercises" / "ml_spec.json"
SPEC = json.loads(SPEC_PATH.read_text())

JOINTS: list[int] = SPEC["joints"]
V = len(JOINTS)
T = SPEC["window"]
CONTEXT_DIM = SPEC["context_dim"]
MIN_TORSO_VIS = SPEC["min_torso_visibility"]
MIRROR_PAIRS: list[list[int]] = SPEC["mirror_pairs"]
EDGES: list[list[int]] = SPEC["edges"]
_LS, _RS, _LH, _RH = (SPEC["torso"][k] for k in ("l_shoulder", "r_shoulder", "l_hip", "r_hip"))

# (origin_x, origin_y, scale, c, s): p' = R(p - origin) / scale with R = [[c, -s], [s, c]]
Transform = tuple[float, float, float, float, float]


def normalize_frame(
    landmarks: np.ndarray, width: float, height: float, prev: Transform | None
) -> tuple[np.ndarray, np.ndarray, Transform | None]:
    """landmarks: (33, 3) MediaPipe (x, y, visibility), x/y normalised to the image.

    Returns joints (V, 3), context (3,) and the transform used. When the torso isn't visible the previous
    frame's transform is reused (context valid flag = 0); with no previous transform everything is zero.
    """
    lm = np.asarray(landmarks, dtype=np.float64)
    px = np.stack([lm[:, 0] * width, lm[:, 1] * height], axis=1)
    vis = np.clip(lm[:, 2], 0.0, 1.0)
    sel = px[JOINTS]
    joint_vis = vis[JOINTS]

    torso_idx = [JOINTS[i] for i in (_LS, _RS, _LH, _RH)]
    valid = bool(np.all(vis[torso_idx] >= MIN_TORSO_VIS))
    transform = prev
    tilt_cos, tilt_sin = 1.0, 0.0
    if valid:
        s_mid = (px[JOINTS[_LS]] + px[JOINTS[_RS]]) / 2
        h_mid = (px[JOINTS[_LH]] + px[JOINTS[_RH]]) / 2
        v = s_mid - h_mid
        length = math.hypot(v[0], v[1])
        if length > 1e-6:
            ux, uy = v[0] / length, v[1] / length
            origin = (s_mid + h_mid) / 2
            transform = (origin[0], origin[1], length, -uy, -ux)
            tilt = math.atan2(abs(ux), -uy)
            tilt_cos, tilt_sin = math.cos(tilt), math.sin(tilt)
        else:
            valid = False
    if transform is None:
        return np.zeros((V, 3)), np.array([1.0, 0.0, 0.0]), None
    ox, oy, scale, c, s = transform
    d = sel - np.array([ox, oy])
    x = (c * d[:, 0] - s * d[:, 1]) / scale
    y = (s * d[:, 0] + c * d[:, 1]) / scale
    joints = np.stack([x, y, joint_vis], axis=1)
    if not valid:
        # Reused transform: keep the last known tilt out of the context so the flag is the only signal.
        tilt_cos, tilt_sin = 1.0, 0.0
    return joints, np.array([tilt_cos, tilt_sin, 1.0 if valid else 0.0]), transform


def normalize_sequence(frames: list[np.ndarray], width: float, height: float) -> tuple[np.ndarray, np.ndarray]:
    """frames: list of (33, 3). Returns joints (F, V, 3) and context (F, 3)."""
    prev: Transform | None = None
    joints, context = [], []
    for f in frames:
        j, c, prev = normalize_frame(f, width, height, prev)
        joints.append(j)
        context.append(c)
    return np.stack(joints), np.stack(context)


def resample(seq: np.ndarray, n: int = T) -> np.ndarray:
    """Linear resample along axis 0 to n frames (rep tempo becomes irrelevant)."""
    f = seq.shape[0]
    if f == n:
        return seq.copy()
    if f == 1:
        return np.repeat(seq, n, axis=0)
    pos = np.linspace(0, f - 1, n)
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, f - 1)
    w = (pos - lo).reshape(-1, *([1] * (seq.ndim - 1)))
    return seq[lo] * (1 - w) + seq[hi] * w


def mirror(joints: np.ndarray, context: np.ndarray | None = None) -> np.ndarray:
    """Left/right flip: negate x and swap paired joints. Context (unsigned tilt) is mirror-invariant."""
    out = joints.copy()
    out[..., 0] = -out[..., 0]
    for a, b in MIRROR_PAIRS:
        out[..., [a, b], :] = out[..., [b, a], :]
    return out


def to_model_input(joints: np.ndarray, context: np.ndarray) -> np.ndarray:
    """(T, V, 3) + (T, 3) -> (8, T, V): x, y, vis, dx, dy, context(3). Velocity is computed from positions."""
    d = np.zeros_like(joints[..., :2])
    d[1:] = joints[1:, :, :2] - joints[:-1, :, :2]
    ctx = np.broadcast_to(context[:, None, :], (joints.shape[0], V, CONTEXT_DIM))
    feats = np.concatenate([joints, d, ctx], axis=-1)  # (T, V, 8)
    return np.transpose(feats, (2, 0, 1)).astype(np.float32)
