"""Spatio-temporal graph network with self-attention (ST-GCN + STSAM) for rep-form classification.

Input  x  (N, 8, 64, 17): normalised joints (x, y, visibility), velocity (dx, dy) and torso-tilt context.
Input  ex (N,) int64: exercise index (conditions a per-exercise joint gate and the classifier head).
Output (N, F): probability of each (exercise, fault) pair; only the exercise's own faults are meaningful.
"""

import math

import numpy as np
import torch
from torch import nn

from ml import skeleton as sk
from ml.vocab import N_EXERCISES, N_FAULTS


def adjacency() -> torch.Tensor:
    """(2, V, V): identity and the row-normalised skeleton adjacency (a fixed spatial partition)."""
    a = np.zeros((sk.V, sk.V), dtype=np.float32)
    for i, j in sk.EDGES:
        a[i, j] = a[j, i] = 1.0
    a = a / a.sum(axis=1, keepdims=True)
    return torch.tensor(np.stack([np.eye(sk.V, dtype=np.float32), a]))


class SpatialGraphConv(nn.Module):
    """Graph convolution with the fixed partitions plus a learned adjacency offset shared across them."""

    def __init__(self, cin: int, cout: int, a: torch.Tensor):
        super().__init__()
        self.k, self.cout = a.shape[0], cout
        self.register_buffer("a", a)
        self.b = nn.Parameter(torch.zeros(sk.V, sk.V))
        self.conv = nn.Conv2d(cin, cout * self.k, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        n, _, t, v = x.shape
        y = self.conv(x).reshape(n, self.k, self.cout, t, v)
        return torch.einsum("nkctv,kvw->nctw", y, self.a + self.b)


class STBlock(nn.Module):
    def __init__(self, cin: int, cout: int, a: torch.Tensor, stride: int = 1, dropout: float = 0.1):
        super().__init__()
        self.gcn = SpatialGraphConv(cin, cout, a)
        self.bn1 = nn.BatchNorm2d(cout)
        self.tcn = nn.Conv2d(cout, cout, (9, 1), (stride, 1), (4, 0))
        self.bn2 = nn.BatchNorm2d(cout)
        self.drop = nn.Dropout(dropout)
        self.res: nn.Module = (
            nn.Identity()
            if cin == cout and stride == 1
            else nn.Sequential(nn.Conv2d(cin, cout, 1, (stride, 1)), nn.BatchNorm2d(cout))
        )
        self.act = nn.ReLU()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.act(self.bn1(self.gcn(x)))
        y = self.drop(self.bn2(self.tcn(y)))
        return self.act(y + self.res(x))


class SelfAttention(nn.Module):
    """Multi-head scaled dot-product attention written with plain matmul/softmax so it exports cleanly to ONNX."""

    def __init__(self, c: int, heads: int):
        super().__init__()
        assert c % heads == 0
        self.h, self.dh = heads, c // heads
        self.qkv = nn.Linear(c, 3 * c)
        self.proj = nn.Linear(c, c)

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # (B, L, C)
        b, l, c = x.shape
        q, k, v = self.qkv(x).reshape(b, l, 3, self.h, self.dh).permute(2, 0, 3, 1, 4)
        att = torch.softmax(q @ k.transpose(-1, -2) / math.sqrt(self.dh), dim=-1)
        return self.proj((att @ v).transpose(1, 2).reshape(b, l, c))


class STSAM(nn.Module):
    """Spatial-temporal self-attention: joints attend to joints within a frame, then frames attend to frames per joint."""

    def __init__(self, c: int, heads: int = 2):
        super().__init__()
        self.n1, self.n2 = nn.LayerNorm(c), nn.LayerNorm(c)
        self.spatial, self.temporal = SelfAttention(c, heads), SelfAttention(c, heads)

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # (N, C, T, V)
        n, c, t, v = x.shape
        s = x.permute(0, 2, 3, 1).reshape(n * t, v, c)
        s = s + self.spatial(self.n1(s))
        x = s.reshape(n, t, v, c)
        f = x.permute(0, 2, 1, 3).reshape(n * v, t, c)
        f = f + self.temporal(self.n2(f))
        return f.reshape(n, v, t, c).permute(0, 3, 2, 1)


class FormNet(nn.Module):
    def __init__(self, in_channels: int = 8, widths=(32, 64, 64), heads: int = 2, ex_dim: int = 16, dropout: float = 0.1):
        super().__init__()
        a = adjacency()
        self.data_bn = nn.BatchNorm2d(in_channels)
        c1, c2, c3 = widths
        self.blocks = nn.Sequential(
            STBlock(in_channels, c1, a, 1, dropout),
            STBlock(c1, c2, a, 2, dropout),
            STBlock(c2, c3, a, 2, dropout),
        )
        self.stsam = STSAM(c3, heads)
        self.joint_gate = nn.Embedding(N_EXERCISES, sk.V)  # per-exercise joint relevance, learned
        nn.init.zeros_(self.joint_gate.weight)
        self.ex_emb = nn.Embedding(N_EXERCISES, ex_dim)
        self.head = nn.Sequential(nn.Linear(c3 + ex_dim, 64), nn.ReLU(), nn.Dropout(dropout), nn.Linear(64, N_FAULTS))

    def logits(self, x: torch.Tensor, ex: torch.Tensor) -> torch.Tensor:
        h = self.stsam(self.blocks(self.data_bn(x)))
        gate = 2 * torch.sigmoid(self.joint_gate(ex))  # 1.0 at init; emphasises or suppresses joints per exercise
        h = h * gate[:, None, None, :]
        pooled = h.mean(dim=(2, 3))
        return self.head(torch.cat([pooled, self.ex_emb(ex)], dim=1))

    def forward(self, x: torch.Tensor, ex: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.logits(x, ex))


def n_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())
