"""Train the rep-form model.

    python -m ml.train --data ml/data/recordings --out ml/artifacts/run1
    python -m ml.train --data ml/data/synthetic --out ml/artifacts/smoke --epochs 25     # pipeline smoke test only

Labels come from reps a person reviewed in the app's Record mode. Reps carrying only rule-engine labels are
ignored unless --use-weak (they teach the model the rules' own mistakes).
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from ml.dataset import RepDataset, load_recordings, split_by_session
from ml.evaluate import compare, macro_f1, predict, prf
from ml.model import FormNet, n_params
from ml.vocab import FAULTS


def pick_device() -> str:
    return "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"


def pos_weights(reps) -> torch.Tensor:
    t = np.stack([r.target for r in reps]); m = np.stack([r.mask for r in reps])
    pos = (t * m).sum(0); neg = ((1 - t) * m).sum(0)
    return torch.tensor(np.clip(neg / np.maximum(pos, 1), 1, 10), dtype=torch.float32)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--use-weak", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    reps = load_recordings(args.data, args.use_weak)
    if len(reps) < 20:
        print(f"Only {len(reps)} usable reps in {args.data}. Record and label more in the app (see ARCHITECTURE.md).")
        return 1
    train, val = split_by_session(reps, seed=args.seed)
    print(f"{len(train)} train / {len(val)} validation reps; {len({r.session for r in reps})} sessions")

    device = pick_device()
    model = FormNet().to(device)
    print(f"FormNet: {n_params(model):,} parameters on {device}")
    loader = DataLoader(RepDataset(train, True, args.seed), batch_size=args.batch, shuffle=True, drop_last=len(train) > args.batch)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * len(loader))
    pw = pos_weights(train).to(device)

    best, history = -1.0, []
    args.out.mkdir(parents=True, exist_ok=True)
    for epoch in range(1, args.epochs + 1):
        model.train()
        total, t0 = 0.0, time.time()
        for x, ex, y, mask, w in loader:
            x, ex, y, mask, w = (a.to(device) for a in (x, ex, y, mask, w))
            loss = torch.nn.functional.binary_cross_entropy_with_logits(model.logits(x, ex), y, pos_weight=pw, reduction="none")
            loss = ((loss * mask).sum(1) / mask.sum(1).clamp(min=1) * w).mean()
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
            total += loss.item()
        row = {"epoch": epoch, "loss": total / len(loader)}
        if val and (epoch % 5 == 0 or epoch == args.epochs):
            truth = np.stack([r.target for r in val]); mask = np.stack([r.mask for r in val])
            row["val_macro_f1"] = macro_f1(prf(predict(model, val, device), truth, mask))
            if (row["val_macro_f1"] or 0) >= best:
                best = row["val_macro_f1"] or 0
                torch.save(model.state_dict(), args.out / "best.pt")
            print(f"epoch {epoch:3d}  loss {row['loss']:.4f}  val macro-F1 {row['val_macro_f1']}  ({time.time() - t0:.1f}s/epoch)")
        history.append(row)
    if not val:
        torch.save(model.state_dict(), args.out / "best.pt")

    model.load_state_dict(torch.load(args.out / "best.pt", map_location=device))
    report = {"params": n_params(model), "n_train": len(train), "n_val": len(val), "history": history, "validation": compare(model.to(device), val, device)}
    (args.out / "metrics.json").write_text(json.dumps(report, indent=1))
    print(f"best val macro-F1: {report['validation'].get('model_macro_f1')}   rules macro-F1: {report['validation'].get('rules_macro_f1')}")
    print("saved", args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
