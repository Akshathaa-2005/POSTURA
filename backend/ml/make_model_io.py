"""Writes model_io.json next to an exported model: a real input and the probabilities Python's onnxruntime
gives for it, so the browser runtime can be checked against Python (frontend/scripts/bench-model.mjs)."""

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

from ml.dataset import RepDataset, load_recordings


def main(onnx_dir: Path, data: Path) -> None:
    reps = load_recordings(data, use_weak=True)[:6]
    ds = RepDataset(reps, train=False)
    cases = []
    for i in range(len(ds)):
        x, ex = ds[i][0].numpy(), int(ds[i][1])
        outs = {}
        for name in ("fp32", "int8"):
            sess = ort.InferenceSession(str(onnx_dir / f"form_model.{name}.onnx"), providers=["CPUExecutionProvider"])
            outs[name] = sess.run(None, {"x": x[None], "ex": np.array([ex], dtype=np.int64)})[0][0].tolist()
        cases.append({"ex": ex, "x": x.reshape(-1).tolist(), **outs})
    (onnx_dir / "model_io.json").write_text(json.dumps({"cases": cases}))
    print("wrote", onnx_dir / "model_io.json")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
