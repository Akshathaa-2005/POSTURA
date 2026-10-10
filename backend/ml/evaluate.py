import numpy as np
import torch

from ml.dataset import Rep, RepDataset
from ml.vocab import FAULTS


@torch.no_grad()
def predict(model, reps: list[Rep], device: str = "cpu") -> np.ndarray:
    model.eval()
    ds = RepDataset(reps, train=False)
    out = []
    for i in range(len(ds)):
        x, ex, *_ = ds[i]
        out.append(model(x[None].to(device), ex[None].to(device))[0].cpu().numpy())
    return np.stack(out) if out else np.zeros((0, len(FAULTS)))


def prf(pred: np.ndarray, truth: np.ndarray, mask: np.ndarray) -> dict[str, dict]:
    """Per-fault precision / recall / F1 over the reps whose exercise defines that fault."""
    res = {}
    for k, name in enumerate(FAULTS):
        m = mask[:, k] > 0
        if not m.any():
            continue
        p, t = pred[m, k] > 0.5, truth[m, k] > 0.5
        tp, fp, fn = int((p & t).sum()), int((p & ~t).sum()), int((~p & t).sum())
        prec = tp / (tp + fp) if tp + fp else None
        rec = tp / (tp + fn) if tp + fn else None
        f1 = 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None
        res[name] = {"n": int(m.sum()), "positives": int(t.sum()), "precision": prec, "recall": rec, "f1": f1}
    return res


def macro_f1(res: dict[str, dict]) -> float | None:
    vals = [r["f1"] for r in res.values() if r["positives"] > 0 and r["f1"] is not None]
    return float(np.mean(vals)) if vals else None


def compare(model, reps: list[Rep], device: str = "cpu") -> dict:
    """Model vs the rule engine, each scored against people's labels on the same held-out reps."""
    reps = [r for r in reps if r.reviewed]
    if not reps:
        return {}
    truth = np.stack([r.target for r in reps])
    mask = np.stack([r.mask for r in reps])
    model_res = prf(predict(model, reps, device), truth, mask)
    out = {"n_reps": len(reps), "model_macro_f1": macro_f1(model_res), "per_fault": model_res}
    with_rules = [r for r in reps if r.rules is not None and r.rules.any() or r.rules is not None]
    if with_rules:
        t = np.stack([r.target for r in with_rules]); m = np.stack([r.mask for r in with_rules])
        rule_res = prf(np.stack([r.rules for r in with_rules]), t, m)
        out["rules_macro_f1"] = macro_f1(rule_res)
        out["rules_per_fault"] = rule_res
    return out
