"""Export a trained checkpoint to ONNX and quantise it to INT8 for the browser (WASM).

    python -m ml.export_onnx --ckpt ml/artifacts/run1/best.pt --data ml/data/recordings --out ml/artifacts/run1/onnx

Writes form_model.fp32.onnx, form_model.int8.onnx and model_meta.json, and reports size, fp32-vs-int8
agreement and Python-side latency. The int8 file is only worth shipping if it agrees with fp32 and the
browser benchmark (frontend/scripts/bench-model.mjs) shows it is not slower.
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
from onnxruntime.quantization.shape_inference import quant_pre_process

from ml import skeleton as sk
from ml.dataset import RepDataset, load_recordings
from ml.model import FormNet
from ml.vocab import EXERCISE_IDS, FAULTS


class Exportable(torch.nn.Module):
    def __init__(self, net: FormNet):
        super().__init__()
        self.net = net

    def forward(self, x, ex):
        return self.net(x, ex)


class Calibration(CalibrationDataReader):
    def __init__(self, samples: list[tuple[np.ndarray, int]]):
        self.it = iter(samples)

    def get_next(self):
        s = next(self.it, None)
        return None if s is None else {"x": s[0][None], "ex": np.array([s[1]], dtype=np.int64)}


def samples_from(reps, limit: int) -> list[tuple[np.ndarray, int]]:
    ds = RepDataset(reps[:limit], train=False)
    return [(ds[i][0].numpy(), int(ds[i][1])) for i in range(len(ds))]


def run(path: Path, samples, threads: int = 1) -> tuple[np.ndarray, float]:
    so = ort.SessionOptions(); so.intra_op_num_threads = threads
    sess = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
    outs, times = [], []
    for x, ex in samples:
        t0 = time.perf_counter()
        outs.append(sess.run(None, {"x": x[None], "ex": np.array([ex], dtype=np.int64)})[0][0])
        times.append((time.perf_counter() - t0) * 1000)
    return np.stack(outs), float(np.median(times[2:] or times))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckpt", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--quant-ops", nargs="+", default=["Conv", "MatMul", "Gemm"])
    ap.add_argument("--calibration", type=int, default=120)
    ap.add_argument("--synthetic", action="store_true", help="Mark the model as trained on synthetic data (never shipped)")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    net = FormNet()
    net.load_state_dict(torch.load(args.ckpt, map_location="cpu"))
    model = Exportable(net.eval())
    fp32, int8 = args.out / "form_model.fp32.onnx", args.out / "form_model.int8.onnx"
    x = torch.randn(1, 8, sk.T, sk.V)
    ex = torch.tensor([0], dtype=torch.int64)
    torch.onnx.export(model, (x, ex), str(fp32), input_names=["x", "ex"], output_names=["probs"], opset_version=18, dynamo=False)
    onnx.checker.check_model(onnx.load(fp32))
    model.eval()  # export restores the wrapper's training mode, which recursively re-enables dropout / batch-norm updates

    reps = load_recordings(args.data, use_weak=True)
    samples = samples_from(reps, max(args.calibration, 40))
    with torch.no_grad():
        ref = np.stack([model(torch.from_numpy(s[None]), torch.tensor([e]))[0].numpy() for s, e in samples[:40]])
    got, _ = run(fp32, samples[:40])
    drift = float(np.abs(ref - got).max())
    print(f"PyTorch vs ONNX fp32 max |diff|: {drift:.2e}")
    if drift > 1e-3:
        raise SystemExit("ONNX export does not reproduce the PyTorch model; refusing to continue")

    pre = args.out / "form_model.pre.onnx"
    quant_pre_process(str(fp32), str(pre), skip_symbolic_shape=True)
    quantize_static(
        str(pre), str(int8), Calibration(samples[: args.calibration]),
        quant_format=QuantFormat.QDQ, per_channel=True,
        activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8, op_types_to_quantize=args.quant_ops,
    )
    pre.unlink()

    eval_samples = samples[:120]
    p32, t32 = run(fp32, eval_samples)
    p8, t8 = run(int8, eval_samples)
    ex_idx = np.array([e for _, e in eval_samples])
    mask = np.array([[1.0 if FAULTS[k].startswith(EXERCISE_IDS[e] + ":") else 0.0 for k in range(len(FAULTS))] for e in ex_idx])
    delta = np.abs(p32 - p8) * mask
    flips = ((p32 > 0.5) != (p8 > 0.5)) & (mask > 0)
    stats = {
        "fp32_mb": round(fp32.stat().st_size / 1e6, 3), "int8_mb": round(int8.stat().st_size / 1e6, 3),
        "python_ort_ms_fp32": round(t32, 2), "python_ort_ms_int8": round(t8, 2),
        "int8_vs_fp32_mean_abs_prob_delta": round(float(delta.sum() / mask.sum()), 4),
        "int8_vs_fp32_max_abs_prob_delta": round(float(delta.max()), 4),
        "int8_vs_fp32_decision_flips": f"{int(flips.sum())} of {int(mask.sum())}",
        "quantized_ops": args.quant_ops,
    }
    print(json.dumps(stats, indent=1))
    meta = {
        "spec_version": sk.SPEC["version"], "window": sk.T, "joints": sk.V, "channels": 8,
        "exercises": EXERCISE_IDS, "faults": FAULTS, "threshold": 0.6,
        "inputs": {"x": [1, 8, sk.T, sk.V], "ex": [1]}, "output": "probs",
        "synthetic": bool(args.synthetic), "export_stats": stats,
    }
    (args.out / "model_meta.json").write_text(json.dumps(meta, indent=1))
    print("wrote", args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
