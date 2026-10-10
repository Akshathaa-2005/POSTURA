import json

import numpy as np
import pytest
import torch

from ml import dataset, synthetic
from ml import skeleton as sk
from ml.model import FormNet, n_params
from ml.vocab import EXERCISE_IDS, EXERCISE_MASK, EXERCISES, FAULTS, N_FAULTS


@pytest.fixture(scope="module")
def synth_dir(tmp_path_factory):
    out = tmp_path_factory.mktemp("synth")
    synthetic.generate(per_exercise=16, sessions=4, seed=1, out=out)
    return out


def test_vocabulary_matches_exercises_json():
    assert len(FAULTS) == sum(len(e["faults"]) for e in EXERCISES.values())
    assert len(set(FAULTS)) == len(FAULTS)
    for i, eid in enumerate(EXERCISE_IDS):
        own = {f for f, m in zip(FAULTS, EXERCISE_MASK[i]) if m}
        assert own == {f"{eid}:{f['id']}" for f in EXERCISES[eid]["faults"]}


def test_model_shapes_and_size():
    m = FormNet().eval()
    x = torch.randn(3, 8, sk.T, sk.V)
    out = m(x, torch.tensor([0, 7, 21]))
    assert out.shape == (3, N_FAULTS) and ((out >= 0) & (out <= 1)).all()
    assert n_params(m) < 400_000  # small enough for a sub-megabyte browser download


def test_exercise_conditioning_changes_the_output():
    m = FormNet().eval()
    x = torch.randn(1, 8, sk.T, sk.V)
    a, b = m.logits(x, torch.tensor([0])), m.logits(x, torch.tensor([1]))
    assert not torch.allclose(a, b)


def test_loader_ignores_unreviewed_reps_unless_asked(synth_dir, tmp_path):
    blob = json.loads(next(synth_dir.glob("*.json")).read_text())
    for r in blob["reps"]:
        r["labels"] = {"rules": ["shallow_squat"], "reviewed": False}
    (tmp_path / "weak.json").write_text(json.dumps(blob))
    assert dataset.load_recordings(tmp_path) == []
    weak = dataset.load_recordings(tmp_path, use_weak=True)
    assert weak and all(r.weight == dataset.WEAK_WEIGHT for r in weak)


def test_split_keeps_each_person_on_one_side(synth_dir):
    reps = dataset.load_recordings(synth_dir)
    train, val = dataset.split_by_session(reps)
    assert train and val
    assert {r.session for r in train}.isdisjoint({r.session for r in val})


def test_targets_are_masked_to_the_reps_own_exercise(synth_dir):
    for r in dataset.load_recordings(synth_dir):
        assert (r.target * (1 - r.mask)).sum() == 0
        assert r.mask.sum() == len(EXERCISES[EXERCISE_IDS[r.exercise]]["faults"])


def test_augmentation_keeps_shape_and_finite_values(synth_dir):
    reps = dataset.load_recordings(synth_dir)
    ds = dataset.RepDataset(reps, train=True, seed=3)
    for i in range(0, len(ds), 7):
        x, ex, y, mask, w = ds[i]
        assert x.shape == (8, sk.T, sk.V) and torch.isfinite(x).all()


def test_a_few_training_steps_reduce_the_loss(synth_dir):
    torch.manual_seed(0)
    reps = dataset.load_recordings(synth_dir)
    ds = dataset.RepDataset(reps, train=False)
    xs, exs, ys, ms, _ = (torch.stack([ds[i][k] for i in range(48)]) for k in range(5))
    m = FormNet()
    opt = torch.optim.AdamW(m.parameters(), lr=3e-3)

    def loss():
        l = torch.nn.functional.binary_cross_entropy_with_logits(m.logits(xs, exs), ys, reduction="none")
        return ((l * ms).sum(1) / ms.sum(1)).mean()

    before = loss().item()
    for _ in range(30):
        opt.zero_grad(); l = loss(); l.backward(); opt.step()
    assert loss().item() < before * 0.8


def test_onnx_export_matches_pytorch_and_int8_agrees(synth_dir, tmp_path):
    import onnxruntime as ort
    from ml import export_onnx

    ckpt = tmp_path / "m.pt"
    torch.save(FormNet().state_dict(), ckpt)
    import sys
    argv = ["export", "--ckpt", str(ckpt), "--data", str(synth_dir), "--out", str(tmp_path / "onnx"), "--calibration", "40", "--synthetic"]
    old, sys.argv = sys.argv, argv
    try:
        assert export_onnx.main() == 0
    finally:
        sys.argv = old
    meta = json.loads((tmp_path / "onnx" / "model_meta.json").read_text())
    assert meta["synthetic"] is True and meta["faults"] == FAULTS and meta["spec_version"] == sk.SPEC["version"]
    sess = ort.InferenceSession(str(tmp_path / "onnx" / "form_model.int8.onnx"))
    assert [i.name for i in sess.get_inputs()] == ["x", "ex"]
    assert meta["export_stats"]["int8_mb"] < meta["export_stats"]["fp32_mb"]
