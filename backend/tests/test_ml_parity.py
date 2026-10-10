import json
import math
from pathlib import Path

import numpy as np
import pytest

from ml import make_golden
from ml import skeleton as sk

GOLDEN = Path(make_golden.OUT)


def test_golden_file_is_current():
    """Regenerating the fixture must give the same numbers (the TypeScript test reads this file)."""
    stored = json.loads(GOLDEN.read_text())
    rng = np.random.default_rng(1234)
    for case in stored["cases"]:
        seq = make_golden.make_sequence(rng)
        joints, context = sk.normalize_sequence(list(seq), case["width"], case["height"])
        np.testing.assert_allclose(joints, case["joints"], atol=1e-12)
        np.testing.assert_allclose(context, case["context"], atol=1e-12)


def _pose(rng):
    p = np.zeros((33, 3))
    p[:, :2] = rng.uniform(0.2, 0.8, size=(33, 2))
    p[:, 2] = 0.95
    return p


def _apply(pose, width, height, fn):
    out = pose.copy()
    for i in range(33):
        x, y = fn(pose[i, 0] * width, pose[i, 1] * height)
        out[i, 0], out[i, 1] = x / width, y / height
    return out


def test_normalisation_ignores_position_distance_and_roll():
    rng = np.random.default_rng(7)
    w, h = 1280, 720
    pose = _pose(rng)
    base, _, _ = sk.normalize_frame(pose, w, h, None)
    a = math.radians(-31)
    moved = _apply(pose, w, h, lambda x, y: ((x - w / 2) * 0.5 + w * 0.3, (y - h / 2) * 0.5 + h * 0.6))
    rolled = _apply(pose, w, h, lambda x, y: (x * math.cos(a) - y * math.sin(a) + 400, x * math.sin(a) + y * math.cos(a) + 50))
    np.testing.assert_allclose(sk.normalize_frame(moved, w, h, None)[0], base, atol=1e-9)
    np.testing.assert_allclose(sk.normalize_frame(rolled, w, h, None)[0], base, atol=1e-9)


def test_torso_is_upright_after_normalisation():
    rng = np.random.default_rng(3)
    j, ctx, _ = sk.normalize_frame(_pose(rng), 640, 480, None)
    sh = (j[1, :2] + j[2, :2]) / 2
    hip = (j[7, :2] + j[8, :2]) / 2
    assert abs(sh[0] - hip[0]) < 1e-9 and sh[1] < hip[1]  # shoulders directly above hips
    assert abs(np.linalg.norm(sh - hip) - 1) < 1e-9  # torso length is the unit of scale
    assert ctx[2] == 1


def test_mirror_twice_is_identity_and_swaps_sides():
    rng = np.random.default_rng(5)
    j, _, _ = sk.normalize_frame(_pose(rng), 640, 480, None)
    m = sk.mirror(j)
    np.testing.assert_allclose(sk.mirror(m), j, atol=1e-12)
    np.testing.assert_allclose(m[1, :2], [-j[2, 0], j[2, 1]], atol=1e-12)  # left shoulder <- mirrored right shoulder


def test_lost_torso_reuses_the_previous_transform():
    rng = np.random.default_rng(9)
    pose = _pose(rng)
    _, _, t = sk.normalize_frame(pose, 640, 480, None)
    lost = pose.copy()
    lost[[11, 12, 23, 24], 2] = 0.05
    j, ctx, t2 = sk.normalize_frame(lost, 640, 480, t)
    assert t2 == t and ctx[2] == 0 and np.isfinite(j).all()
    j0, ctx0, t0 = sk.normalize_frame(lost, 640, 480, None)
    assert t0 is None and not j0.any() and ctx0[2] == 0


def test_resample_hits_the_endpoints():
    seq = np.arange(10, dtype=float).reshape(10, 1)
    out = sk.resample(seq, 64)
    assert out.shape == (64, 1) and out[0, 0] == 0 and out[-1, 0] == 9


def test_standing_and_lying_stay_distinguishable():
    stand = np.zeros((33, 3)); stand[:, 2] = 1
    stand[11] = [0.45, 0.3, 1]; stand[12] = [0.55, 0.3, 1]; stand[23] = [0.46, 0.6, 1]; stand[24] = [0.54, 0.6, 1]
    lying = stand.copy()
    lying[:, [0, 1]] = lying[:, [1, 0]]  # rotate the whole body 90 degrees in the image
    _, c_stand, _ = sk.normalize_frame(stand, 640, 640, None)
    _, c_lie, _ = sk.normalize_frame(lying, 640, 640, None)
    assert abs(c_stand[1]) < 1e-9 and abs(c_lie[1]) > 0.99  # sin(tilt): 0 standing, 1 lying
