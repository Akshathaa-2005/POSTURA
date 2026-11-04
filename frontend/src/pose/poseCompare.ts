import type { JointName } from "@/types";
import { LM, type Landmark } from "@/types/mediapipe";
import { JOINT_TRIPLETS, MIN_VISIBILITY } from "@/utils/poseValidation";

/**
 * Metrics for comparing two pose sources (A = MediaPipe, B = YOLO) run over the same clip. There is no ground
 * truth here, so everything is *relative*: how far the sources disagree, how often each loses a joint, and how
 * much each jitters. Pure TypeScript; the browser harness is `pages/dev/pose-compare.tsx`.
 */

export interface CompareFrame {
  /** Seconds into the clip. */
  t: number;
  width: number;
  height: number;
  a: Landmark[] | null;
  b: Landmark[] | null;
  /** Inference time of each source for this frame, in ms. */
  aMs: number;
  bMs: number;
}

export const COMPARE_JOINTS = [
  ["left_shoulder", LM.LEFT_SHOULDER],
  ["right_shoulder", LM.RIGHT_SHOULDER],
  ["left_elbow", LM.LEFT_ELBOW],
  ["right_elbow", LM.RIGHT_ELBOW],
  ["left_wrist", LM.LEFT_WRIST],
  ["right_wrist", LM.RIGHT_WRIST],
  ["left_hip", LM.LEFT_HIP],
  ["right_hip", LM.RIGHT_HIP],
  ["left_knee", LM.LEFT_KNEE],
  ["right_knee", LM.RIGHT_KNEE],
  ["left_ankle", LM.LEFT_ANKLE],
  ["right_ankle", LM.RIGHT_ANKLE],
] as const;

export interface JointStats {
  name: string;
  /** Fraction of frames where the joint is missing or below the visibility gate. */
  dropoutA: number;
  dropoutB: number;
  /** Distance between A and B when both see the joint, as a fraction of torso length. null if never both. */
  disagreementMean: number | null;
  disagreementP95: number | null;
  /** RMS second difference of position / torso length. Unitless: only compare A against B. */
  jitterA: number | null;
  jitterB: number | null;
}

export interface AngleStats {
  name: JointName;
  samples: number;
  meanAbsDiffDeg: number | null;
  p95AbsDiffDeg: number | null;
}

export interface LatencyStats {
  p50: number;
  p95: number;
}

export interface CompareReport {
  frames: number;
  /** Frames where each source found no person at all. */
  noPoseA: number;
  noPoseB: number;
  /** Median torso length in pixels, the unit for disagreement and jitter. null if no torso was ever visible. */
  torsoPx: number | null;
  latency: { a: LatencyStats; b: LatencyStats };
  joints: JointStats[];
  angles: AngleStats[];
}

export interface CompareOptions {
  /** A joint counts as seen at or above this. MediaPipe visibility and YOLO score are not calibrated alike. */
  minVisibilityA?: number;
  minVisibilityB?: number;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
const orNull = (v: number) => (Number.isNaN(v) ? null : v);

type Pt = [number, number];

function angleDeg(a: Pt, v: Pt, c: Pt): number {
  const [ax, ay, cx, cy] = [a[0] - v[0], a[1] - v[1], c[0] - v[0], c[1] - v[1]];
  const denom = Math.hypot(ax, ay) * Math.hypot(cx, cy);
  if (denom === 0) return NaN;
  return (Math.acos(Math.max(-1, Math.min(1, (ax * cx + ay * cy) / denom))) * 180) / Math.PI;
}

export function compareSources(frames: CompareFrame[], opts: CompareOptions = {}): CompareReport {
  const gateA = opts.minVisibilityA ?? MIN_VISIBILITY;
  const gateB = opts.minVisibilityB ?? MIN_VISIBILITY;
  const point = (f: CompareFrame, lm: Landmark[] | null, gate: number, idx: number): Pt | null => {
    const l = lm?.[idx];
    return l && l.visibility >= gate ? [l.x * f.width, l.y * f.height] : null;
  };
  const ptA = (f: CompareFrame, i: number) => point(f, f.a, gateA, i);
  const ptB = (f: CompareFrame, i: number) => point(f, f.b, gateB, i);

  // One torso length for the whole clip so A and B are measured on the same scale.
  const torsos: number[] = [];
  for (const f of frames) {
    for (const pt of [ptA, ptB]) {
      const [ls, rs, lh, rh] = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP].map((i) => pt(f, i));
      if (ls && rs && lh && rh) {
        torsos.push(Math.hypot((ls[0] + rs[0]) / 2 - (lh[0] + rh[0]) / 2, (ls[1] + rs[1]) / 2 - (lh[1] + rh[1]) / 2));
      }
    }
  }
  const torsoPx = torsos.length ? percentile(torsos, 50) : null;
  const unit = torsoPx || NaN;

  const jitter = (series: (Pt | null)[]): number | null => {
    const sq: number[] = [];
    for (let i = 1; i < series.length - 1; i++) {
      const [p0, p1, p2] = [series[i - 1], series[i], series[i + 1]];
      if (!p0 || !p1 || !p2) continue;
      sq.push(((p0[0] - 2 * p1[0] + p2[0]) / unit) ** 2 + ((p0[1] - 2 * p1[1] + p2[1]) / unit) ** 2);
    }
    return sq.length ? Math.sqrt(sq.reduce((s, x) => s + x, 0) / sq.length) : null;
  };

  const joints: JointStats[] = COMPARE_JOINTS.map(([name, idx]) => {
    const sa = frames.map((f) => ptA(f, idx));
    const sb = frames.map((f) => ptB(f, idx));
    const dist: number[] = [];
    sa.forEach((a, i) => {
      const b = sb[i];
      if (a && b) dist.push(Math.hypot(a[0] - b[0], a[1] - b[1]) / unit);
    });
    return {
      name,
      dropoutA: frames.length ? sa.filter((p) => !p).length / frames.length : 0,
      dropoutB: frames.length ? sb.filter((p) => !p).length / frames.length : 0,
      disagreementMean: mean(dist),
      disagreementP95: dist.length ? orNull(percentile(dist, 95)) : null,
      jitterA: jitter(sa),
      jitterB: jitter(sb),
    };
  });

  const angles: AngleStats[] = (Object.keys(JOINT_TRIPLETS) as JointName[]).map((name) => {
    const [ia, iv, ic] = JOINT_TRIPLETS[name];
    const diffs: number[] = [];
    for (const f of frames) {
      const [a1, v1, c1, a2, v2, c2] = [ptA(f, ia), ptA(f, iv), ptA(f, ic), ptB(f, ia), ptB(f, iv), ptB(f, ic)];
      if (!a1 || !v1 || !c1 || !a2 || !v2 || !c2) continue;
      const d = Math.abs(angleDeg(a1, v1, c1) - angleDeg(a2, v2, c2));
      if (!Number.isNaN(d)) diffs.push(d);
    }
    return { name, samples: diffs.length, meanAbsDiffDeg: mean(diffs), p95AbsDiffDeg: diffs.length ? percentile(diffs, 95) : null };
  });

  const lat = (xs: number[]): LatencyStats => ({ p50: percentile(xs, 50), p95: percentile(xs, 95) });
  return {
    frames: frames.length,
    noPoseA: frames.filter((f) => !f.a).length,
    noPoseB: frames.filter((f) => !f.b).length,
    torsoPx,
    latency: { a: lat(frames.map((f) => f.aMs)), b: lat(frames.map((f) => f.bMs)) },
    joints,
    angles,
  };
}
