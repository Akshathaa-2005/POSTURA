import type {
  Exercise,
  FaultHit,
  FaultRule,
  GlobalMetric,
  JointAngles,
  JointName,
  JointType,
  MetricName,
  SetupRule,
  Side,
  SidedMetric,
} from "@/types";
import { LM, type Landmark } from "@/types/mediapipe";

/** [a, vertex, c] landmark triplets: the joint angle is measured at the vertex. */
export const JOINT_TRIPLETS: Record<JointName, [number, number, number]> = {
  left_shoulder: [LM.LEFT_HIP, LM.LEFT_SHOULDER, LM.LEFT_ELBOW],
  right_shoulder: [LM.RIGHT_HIP, LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW],
  left_elbow: [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST],
  right_elbow: [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
  left_hip: [LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE],
  right_hip: [LM.RIGHT_SHOULDER, LM.RIGHT_HIP, LM.RIGHT_KNEE],
  left_knee: [LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE],
  right_knee: [LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
};

const JOINT_NAMES = Object.keys(JOINT_TRIPLETS) as JointName[];
const JOINT_TYPES: JointType[] = ["shoulder", "elbow", "hip", "knee"];
export const SIDED_METRICS: SidedMetric[] = [...JOINT_TYPES, "hands_overhead"];

const SIDE_LM = {
  left: { shoulder: LM.LEFT_SHOULDER, elbow: LM.LEFT_ELBOW, wrist: LM.LEFT_WRIST, hip: LM.LEFT_HIP, knee: LM.LEFT_KNEE, ankle: LM.LEFT_ANKLE },
  right: { shoulder: LM.RIGHT_SHOULDER, elbow: LM.RIGHT_ELBOW, wrist: LM.RIGHT_WRIST, hip: LM.RIGHT_HIP, knee: LM.RIGHT_KNEE, ankle: LM.RIGHT_ANKLE },
} as const;

export const MIN_VISIBILITY = 0.5;

export function isSided(metric: MetricName): metric is SidedMetric {
  return (SIDED_METRICS as string[]).includes(metric);
}

// ---- Geometry -------------------------------------------------------------------

interface Pt {
  x: number;
  y: number;
}

/** Angle ABC in degrees (0-180), measured in pixel space so non-square frames don't skew it. */
export function computeAngle(a: Landmark, b: Landmark, c: Landmark, width: number, height: number): number {
  const abx = (a.x - b.x) * width;
  const aby = (a.y - b.y) * height;
  const cbx = (c.x - b.x) * width;
  const cby = (c.y - b.y) * height;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (mag === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, (abx * cbx + aby * cby) / mag))) * 180) / Math.PI;
}

/** Joint angles for every joint whose three landmarks are confidently visible. */
export function computeJointAngles(landmarks: Landmark[], width: number, height: number): JointAngles {
  const angles: JointAngles = {};
  for (const joint of JOINT_NAMES) {
    const pts = JOINT_TRIPLETS[joint].map((i) => landmarks[i]);
    if (pts.some((p) => !p || (p.visibility ?? 1) < MIN_VISIBILITY)) continue;
    angles[joint] = computeAngle(pts[0], pts[1], pts[2], width, height);
  }
  return angles;
}

/** Mean visibility of one side's limb landmarks — used to pick the side facing the camera. */
export function sideVisibility(landmarks: Landmark[], side: Side): number {
  const idx = Object.values(SIDE_LM[side]);
  return idx.reduce((s, i) => s + (landmarks[i]?.visibility ?? 0), 0) / idx.length;
}

// ---- Metrics --------------------------------------------------------------------

export interface FrameMetrics {
  sided: Record<SidedMetric, Partial<Record<Side, number>>>;
  global: Partial<Record<GlobalMetric, number>>;
}

/**
 * Computes every metric the fault rules can reference.
 * `sides` are the body sides to evaluate: both in front view, the camera-facing one in side view.
 */
export function computeMetrics(
  lm: Landmark[],
  width: number,
  height: number,
  angles: JointAngles,
  sides: Side[],
): FrameMetrics {
  const visible = (i: number) => !!lm[i] && (lm[i].visibility ?? 1) >= MIN_VISIBILITY;
  const px = (i: number): Pt => ({ x: lm[i].x * width, y: lm[i].y * height });
  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

  const sided = { shoulder: {}, elbow: {}, hip: {}, knee: {}, hands_overhead: {} } as FrameMetrics["sided"];
  const global: FrameMetrics["global"] = {};

  for (const side of sides) {
    for (const type of JOINT_TYPES) {
      const a = angles[`${side}_${type}` as JointName];
      if (a !== undefined) sided[type][side] = a;
    }
    // Wrist height above the nose, in torso lengths (+ = hand above head).
    const s = SIDE_LM[side];
    if (visible(LM.NOSE) && visible(s.wrist) && visible(s.shoulder) && visible(s.hip)) {
      const torso = dist(px(s.shoulder), px(s.hip));
      if (torso > 0) sided.hands_overhead[side] = (px(LM.NOSE).y - px(s.wrist).y) / torso;
    }
  }

  // Torso lean from vertical (0 = upright, 90 = horizontal), using the evaluated side(s).
  const torsoSides = sides.filter((sd) => visible(SIDE_LM[sd].shoulder) && visible(SIDE_LM[sd].hip));
  if (torsoSides.length) {
    const sh = torsoSides.map((sd) => px(SIDE_LM[sd].shoulder));
    const hp = torsoSides.map((sd) => px(SIDE_LM[sd].hip));
    const shoulder = sh.length === 2 ? mid(sh[0], sh[1]) : sh[0];
    const hip = hp.length === 2 ? mid(hp[0], hp[1]) : hp[0];
    const len = dist(shoulder, hip);
    if (len > 0) global.torso_lean = (Math.acos(Math.max(-1, Math.min(1, (hip.y - shoulder.y) / len))) * 180) / Math.PI;
  }

  // Hip sag: how far the hip sits below (+) or above (−) the shoulder→ankle line, as % of body length.
  // Only meaningful when the body is roughly horizontal (plank / push-up).
  const sagSide = sides.find((sd) => [SIDE_LM[sd].shoulder, SIDE_LM[sd].hip, SIDE_LM[sd].ankle].every(visible));
  if (sagSide) {
    const S = px(SIDE_LM[sagSide].shoulder);
    const H = px(SIDE_LM[sagSide].hip);
    const A = px(SIDE_LM[sagSide].ankle);
    if (Math.abs(A.x - S.x) > Math.abs(A.y - S.y)) {
      const lineY = S.y + ((A.y - S.y) * (H.x - S.x)) / (A.x - S.x);
      global.hip_sag = ((H.y - lineY) / dist(S, A)) * 100;
    }
  }

  // Stance width: ankle spread relative to shoulder width (front view).
  if ([LM.LEFT_ANKLE, LM.RIGHT_ANKLE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER].every(visible)) {
    const shoulders = Math.abs(px(LM.LEFT_SHOULDER).x - px(LM.RIGHT_SHOULDER).x);
    if (shoulders > 1) global.stance_width = Math.abs(px(LM.LEFT_ANKLE).x - px(LM.RIGHT_ANKLE).x) / shoulders;
  }

  // Most-bent knee among visible legs (both legs matter in a lunge, whichever faces the camera).
  const knees = [angles.left_knee, angles.right_knee].filter((a): a is number => a !== undefined);
  if (knees.length) global.knee_min = Math.min(...knees);

  return { sided, global };
}

export interface MetricValue {
  side: Side | null;
  value: number;
}

export function metricValues(m: FrameMetrics, metric: MetricName): MetricValue[] {
  if (isSided(metric)) {
    return (Object.entries(m.sided[metric]) as [Side, number][]).map(([side, value]) => ({ side, value }));
  }
  const v = m.global[metric];
  return v === undefined ? [] : [{ side: null, value: v }];
}

// ---- Rules ----------------------------------------------------------------------

const holds = (op: "<" | ">", value: number, threshold: number) => (op === "<" ? value < threshold : value > threshold);

export function evaluateRule(rule: FaultRule, values: MetricValue[]): FaultHit | null {
  const hits = values.filter((v) => holds(rule.op, v.value, rule.warn));
  if (!hits.length) return null;
  const bad = rule.bad !== undefined && hits.some((v) => holds(rule.op, v.value, rule.bad!));
  const worst = rule.op === ">" ? Math.max(...hits.map((h) => h.value)) : Math.min(...hits.map((h) => h.value));
  return {
    rule,
    status: bad ? "bad" : "warn",
    sides: hits.map((h) => h.side).filter((s): s is Side => s !== null),
    value: worst,
  };
}

export function setupSatisfied(setup: SetupRule | undefined, m: FrameMetrics): boolean {
  if (!setup) return true;
  const values = metricValues(m, setup.metric);
  return values.length > 0 && values.every((v) => holds(setup.op, v.value, setup.value));
}

export function faultMessage(hit: FaultHit, exercise: Exercise): string {
  const { rule, sides } = hit;
  if (exercise.view === "front" && sides.length === 1 && rule.cue_side) {
    return rule.cue_side.replace("{side}", sides[0]);
  }
  return rule.cue;
}

// ---- Scoring & display ----------------------------------------------------------

export const PENALTY = { warn: 15, bad: 35 } as const;

export type BodyRegion = "upper" | "core" | "lower";

export const METRIC_REGION: Record<MetricName, BodyRegion> = {
  shoulder: "upper",
  elbow: "upper",
  hands_overhead: "upper",
  hip: "core",
  torso_lean: "core",
  hip_sag: "core",
  knee: "lower",
  knee_min: "lower",
  stance_width: "lower",
};

/** Landmarks to highlight on the skeleton for a metric. */
export function metricLandmarks(metric: MetricName, sides: Side[]): number[] {
  const both: Side[] = ["left", "right"];
  const on = (pick: (s: (typeof SIDE_LM)[Side]) => number, ss: Side[] = sides) => ss.map((s) => pick(SIDE_LM[s]));
  switch (metric) {
    case "shoulder":
      return on((s) => s.shoulder);
    case "elbow":
      return on((s) => s.elbow);
    case "hip":
      return on((s) => s.hip);
    case "knee":
      return on((s) => s.knee);
    case "hands_overhead":
      return on((s) => s.wrist);
    case "knee_min":
      return on((s) => s.knee, both);
    case "torso_lean":
      return [...on((s) => s.shoulder), ...on((s) => s.hip)];
    case "hip_sag":
      return on((s) => s.hip);
    case "stance_width":
      return on((s) => s.ankle, both);
  }
}
