// Skeleton normalisation shared with the Python trainer (backend/ml/skeleton.py) through exercises/ml_spec.json.
// Keep the two in sync: src/ml/skeleton.test.ts and backend/tests/test_ml_parity.py check the same golden file.
import spec from "@exercises/ml_spec.json";
import type { Landmark } from "@/types/mediapipe";

export const SPEC = spec;
export const JOINTS: number[] = spec.joints;
export const V = JOINTS.length;
export const T: number = spec.window;
export const CONTEXT_DIM: number = spec.context_dim;
export const MODEL_CHANNELS = 3 + 2 + CONTEXT_DIM;
const MIN_TORSO_VIS: number = spec.min_torso_visibility;
const [LS, RS, LH, RH] = [spec.torso.l_shoulder, spec.torso.r_shoulder, spec.torso.l_hip, spec.torso.r_hip];

/** origin x, origin y, scale, c, s: p' = R(p - origin) / scale with R = [[c, -s], [s, c]]. */
export type Transform = [number, number, number, number, number];

export interface NormalizedFrame {
  /** V * 3 values: x, y, visibility per joint. */
  joints: Float64Array;
  /** cos tilt, sin tilt, torso-valid flag. */
  context: Float64Array;
  transform: Transform | null;
}

export function normalizeFrame(lm: Landmark[], width: number, height: number, prev: Transform | null): NormalizedFrame {
  const px = (i: number) => [lm[i].x * width, lm[i].y * height] as const;
  const vis = (i: number) => Math.min(1, Math.max(0, lm[i].visibility ?? 0));

  let valid = [JOINTS[LS], JOINTS[RS], JOINTS[LH], JOINTS[RH]].every((i) => vis(i) >= MIN_TORSO_VIS);
  let transform = prev;
  let tiltCos = 1;
  let tiltSin = 0;
  if (valid) {
    const [sl, rs, lh, rh] = [px(JOINTS[LS]), px(JOINTS[RS]), px(JOINTS[LH]), px(JOINTS[RH])];
    const s = [(sl[0] + rs[0]) / 2, (sl[1] + rs[1]) / 2];
    const h = [(lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2];
    const vx = s[0] - h[0];
    const vy = s[1] - h[1];
    const length = Math.hypot(vx, vy);
    if (length > 1e-6) {
      const ux = vx / length;
      const uy = vy / length;
      transform = [(s[0] + h[0]) / 2, (s[1] + h[1]) / 2, length, -uy, -ux];
      const tilt = Math.atan2(Math.abs(ux), -uy);
      tiltCos = Math.cos(tilt);
      tiltSin = Math.sin(tilt);
    } else {
      valid = false;
    }
  }
  const joints = new Float64Array(V * 3);
  if (!transform) return { joints, context: Float64Array.of(1, 0, 0), transform: null };
  const [ox, oy, scale, c, s] = transform;
  JOINTS.forEach((mp, k) => {
    const [x, y] = px(mp);
    const dx = x - ox;
    const dy = y - oy;
    joints[k * 3] = (c * dx - s * dy) / scale;
    joints[k * 3 + 1] = (s * dx + c * dy) / scale;
    joints[k * 3 + 2] = vis(mp);
  });
  return { joints, context: valid ? Float64Array.of(tiltCos, tiltSin, 1) : Float64Array.of(1, 0, 0), transform };
}

/** Linear resample of `rows` frames (each `width` numbers, flattened) to `n` frames. */
export function resample(data: Float64Array, rows: number, width: number, n: number = T): Float64Array {
  const out = new Float64Array(n * width);
  if (rows === 1) {
    for (let i = 0; i < n; i++) out.set(data.subarray(0, width), i * width);
    return out;
  }
  for (let i = 0; i < n; i++) {
    const pos = (i * (rows - 1)) / (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, rows - 1);
    const w = pos - lo;
    for (let k = 0; k < width; k++) out[i * width + k] = data[lo * width + k] * (1 - w) + data[hi * width + k] * w;
  }
  return out;
}

/** Model input (C = 8, T, V) as a flat Float32Array in C-major order: x, y, vis, dx, dy, context(3). */
export function toModelInput(joints: Float64Array, context: Float64Array, frames: number = T): Float32Array {
  const out = new Float32Array(MODEL_CHANNELS * frames * V);
  const at = (c: number, t: number, v: number) => (c * frames + t) * V + v;
  for (let t = 0; t < frames; t++) {
    for (let v = 0; v < V; v++) {
      const base = (t * V + v) * 3;
      out[at(0, t, v)] = joints[base];
      out[at(1, t, v)] = joints[base + 1];
      out[at(2, t, v)] = joints[base + 2];
      if (t > 0) {
        const prev = ((t - 1) * V + v) * 3;
        out[at(3, t, v)] = joints[base] - joints[prev];
        out[at(4, t, v)] = joints[base + 1] - joints[prev + 1];
      }
      for (let k = 0; k < CONTEXT_DIM; k++) out[at(5 + k, t, v)] = context[t * CONTEXT_DIM + k];
    }
  }
  return out;
}
