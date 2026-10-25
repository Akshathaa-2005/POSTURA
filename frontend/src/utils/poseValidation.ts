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
export const SIDED_METRICS: SidedMetric[] = [...JOINT_TYPES, "hands_overhead", "wrist_drift", "wrist_above_shoulder"];

const SIDE_LM = {
  left: { shoulder: LM.LEFT_SHOULDER, elbow: LM.LEFT_ELBOW, wrist: LM.LEFT_WRIST, hip: LM.LEFT_HIP, knee: LM.LEFT_KNEE, ankle: LM.LEFT_ANKLE },
  right: { shoulder: LM.RIGHT_SHOULDER, elbow: LM.RIGHT_ELBOW, wrist: LM.RIGHT_WRIST, hip: LM.RIGHT_HIP, knee: LM.RIGHT_KNEE, ankle: LM.RIGHT_ANKLE },
} as const;

export const MIN_VISIBILITY = 0.5;
/** Hip sag needs a floor direction: skip lines steeper than about 70° from horizontal. */
const SAG_MIN_NORMAL_Y = 0.35;
/** A far-side limb only counts for the knee metrics when it is detected this confidently (side view). */
const FAR_SIDE_VISIBILITY = 0.85;

/** Landmark indices of one body side, for the engine's "is the body in frame" check. */
export const sideLandmarks = (side: Side) => SIDE_LM[side];
/**
 * MediaPipe still "detects" limbs that are cut off by the frame edge; a point past the sides or bottom is a guess.
 * The top edge is more forgiving: hands raised overhead (presses, jumping jacks) legitimately leave the frame there,
 * and their position is still well estimated from the arm.
 */
const FRAME_MARGIN = 0.02;
const TOP_MARGIN = 0.3;
/** Feet sit at the bottom edge of most webcam framings and are still tracked a little past it. */
const ANKLE_BOTTOM_MARGIN = 0.1;

/** A landmark that is confidently detected and actually inside the camera frame. */
export function usable(p: Landmark | undefined, bottomMargin = FRAME_MARGIN): p is Landmark {
  return (
    !!p &&
    (p.visibility ?? 1) >= MIN_VISIBILITY &&
    p.x >= -FRAME_MARGIN &&
    p.x <= 1 + FRAME_MARGIN &&
    p.y >= -TOP_MARGIN &&
    p.y <= 1 + bottomMargin
  );
}

/** `usable` for landmark `index`, which lets ankles sit slightly further past the bottom edge than other joints. */
export function usableAt(lm: Landmark[], index: number): boolean {
  return usable(lm[index], index === LM.LEFT_ANKLE || index === LM.RIGHT_ANKLE ? ANKLE_BOTTOM_MARGIN : FRAME_MARGIN);
}

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
    if (!JOINT_TRIPLETS[joint].every((i) => usableAt(landmarks, i))) continue;
    angles[joint] = computeAngle(pts[0], pts[1], pts[2], width, height);
  }
  return angles;
}

/** Mean visibility of one side's limb landmarks — used to pick the side facing the camera. */
export function sideVisibility(landmarks: Landmark[], side: Side): number {
  const idx = Object.values(SIDE_LM[side]);
  return idx.reduce((s, i) => s + (usableAt(landmarks, i) ? landmarks[i].visibility ?? 0 : 0), 0) / idx.length;
}

// ---- Metrics --------------------------------------------------------------------

/** The side whose listed landmarks are all usable, preferring the one detected most confidently. */
function bestSideOf(lm: Landmark[], sides: Side[], pick: (side: Side) => number[]): Side | undefined {
  let best: Side | undefined;
  let bestScore = -1;
  for (const sd of sides) {
    const idx = pick(sd);
    if (!idx.every((i) => usableAt(lm, i))) continue;
    const score = idx.reduce((t, i) => t + (lm[i].visibility ?? 1), 0) / idx.length;
    if (score > bestScore) [best, bestScore] = [sd, score];
  }
  return best;
}

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
  const visible = (i: number) => usableAt(lm, i);
  const px = (i: number): Pt => ({ x: lm[i].x * width, y: lm[i].y * height });
  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

  const sided = { shoulder: {}, elbow: {}, hip: {}, knee: {}, hands_overhead: {}, wrist_drift: {}, wrist_above_shoulder: {} } as FrameMetrics["sided"];
  const global: FrameMetrics["global"] = {};

  for (const side of sides) {
    for (const type of JOINT_TYPES) {
      const a = angles[`${side}_${type}` as JointName];
      if (a !== undefined) sided[type][side] = a;
    }
    const s = SIDE_LM[side];
    // Where the wrist is relative to the shoulder, in arm lengths: tells a press going up from one going forward.
    if (visible(s.shoulder) && visible(s.elbow) && visible(s.wrist)) {
      const arm = dist(px(s.shoulder), px(s.elbow)) + dist(px(s.elbow), px(s.wrist));
      if (arm > 1) {
        sided.wrist_drift[side] = Math.abs(px(s.wrist).x - px(s.shoulder).x) / arm;
        sided.wrist_above_shoulder[side] = (px(s.shoulder).y - px(s.wrist).y) / arm;
      }
    }
    // Wrist height above the nose, in torso lengths (+ = hand above head).
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
  // Measured against the line's normal that points towards the floor (image-down), so it also works when the body is
  // tilted (side plank seen from the front). Not measurable when the line is nearly vertical: "down" is then ambiguous.
  const sagSide = bestSideOf(lm, sides, (sd) => [SIDE_LM[sd].shoulder, SIDE_LM[sd].hip, SIDE_LM[sd].ankle]);
  if (sagSide) {
    const S = px(SIDE_LM[sagSide].shoulder);
    const H = px(SIDE_LM[sagSide].hip);
    const A = px(SIDE_LM[sagSide].ankle);
    const len = dist(S, A);
    if (len > 1) {
      const ux = (A.x - S.x) / len;
      const uy = (A.y - S.y) / len;
      const down = Math.abs(ux); // y-component of the line's floor-facing normal
      if (down >= SAG_MIN_NORMAL_Y) {
        const sign = ux >= 0 ? 1 : -1; // flips the normal (−uy, ux) so that it points image-down
        const offset = (H.x - S.x) * (-uy * sign) + (H.y - S.y) * (ux * sign);
        // Within 45° of horizontal this is the hip's vertical offset from the line; steeper, it stays continuous.
        global.hip_sag = (offset / Math.max(down, Math.SQRT1_2) / len) * 100;
      }
    }
  }

  // View ratio: shoulder width ÷ torso length. About 0.8 facing the camera, near 0 when seen from the side.
  // Unmeasured (and so never blocks anything) unless both shoulders and at least one hip are clearly visible.
  const hipsSeen = [LM.LEFT_HIP, LM.RIGHT_HIP].filter(visible);
  if (visible(LM.LEFT_SHOULDER) && visible(LM.RIGHT_SHOULDER) && hipsSeen.length) {
    const shoulderMid = mid(px(LM.LEFT_SHOULDER), px(LM.RIGHT_SHOULDER));
    const hipMid = hipsSeen.length === 2 ? mid(px(LM.LEFT_HIP), px(LM.RIGHT_HIP)) : px(hipsSeen[0]);
    const torso = dist(shoulderMid, hipMid);
    if (torso > 1) global.view_ratio = dist(px(LM.LEFT_SHOULDER), px(LM.RIGHT_SHOULDER)) / torso;
  } else if (visible(LM.LEFT_SHOULDER) && visible(LM.RIGHT_SHOULDER) && visible(LM.NOSE)) {
    // Hips are out of frame (webcam close up): use the neck length instead. Measured on a real webcam, facing the
    // camera gives shoulder width ≈ 3 × shoulder-midpoint-to-nose distance, which is a ratio of 0.8 on the torso
    // scale above, so divide by 3.75 × neck to keep the same scale (and the same view thresholds).
    const neck = dist(mid(px(LM.LEFT_SHOULDER), px(LM.RIGHT_SHOULDER)), px(LM.NOSE));
    if (neck > 1) global.view_ratio = dist(px(LM.LEFT_SHOULDER), px(LM.RIGHT_SHOULDER)) / (3.75 * neck);
  }

  // Stance width: ankle spread relative to shoulder width (front view).
  if ([LM.LEFT_ANKLE, LM.RIGHT_ANKLE, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER].every(visible)) {
    const shoulders = Math.abs(px(LM.LEFT_SHOULDER).x - px(LM.RIGHT_SHOULDER).x);
    if (shoulders > 1) global.stance_width = Math.abs(px(LM.LEFT_ANKLE).x - px(LM.RIGHT_ANKLE).x) / shoulders;
  }

  // Most-bent / straightest knee among the judged side(s). A lunge uses both legs, but in side view the far leg is
  // mostly guessed, so it only counts when it is detected confidently.
  const kneeSides = (["left", "right"] as Side[]).filter((sd) => {
    if (sides.includes(sd)) return true;
    const far = Object.values(SIDE_LM[sd]).filter((i) => i === SIDE_LM[sd].hip || i === SIDE_LM[sd].knee || i === SIDE_LM[sd].ankle);
    return far.every((i) => visible(i) && (lm[i].visibility ?? 0) >= FAR_SIDE_VISIBILITY);
  });
  const knees = kneeSides.map((sd) => angles[`${sd}_knee` as JointName]).filter((a): a is number => a !== undefined);
  if (knees.length) {
    global.knee_min = Math.min(...knees);
    global.knee_max = Math.max(...knees);
  }

  // Knee tracking (front view): knee spread ÷ ankle spread; < 1 means the knees cave inward.
  if ([LM.LEFT_KNEE, LM.RIGHT_KNEE, LM.LEFT_ANKLE, LM.RIGHT_ANKLE].every(visible)) {
    const ankles = Math.abs(px(LM.LEFT_ANKLE).x - px(LM.RIGHT_ANKLE).x);
    if (ankles > 1) global.knee_track = Math.abs(px(LM.LEFT_KNEE).x - px(LM.RIGHT_KNEE).x) / ankles;
  }

  // Knee lift: the higher knee's height relative to its hip, in torso lengths (0 = hip height, − = below).
  const lifts = (["left", "right"] as Side[])
    .filter((sd) => [SIDE_LM[sd].shoulder, SIDE_LM[sd].hip, SIDE_LM[sd].knee].every(visible))
    .map((sd) => {
      const torso = dist(px(SIDE_LM[sd].shoulder), px(SIDE_LM[sd].hip));
      return torso > 0 ? (px(SIDE_LM[sd].hip).y - px(SIDE_LM[sd].knee).y) / torso : undefined;
    })
    .filter((v): v is number => v !== undefined);
  if (lifts.length) global.knee_lift_max = Math.max(...lifts);

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
  wrist_drift: "upper",
  wrist_above_shoulder: "upper",
  hip: "core",
  torso_lean: "core",
  hip_sag: "core",
  knee: "lower",
  knee_min: "lower",
  knee_max: "lower",
  knee_track: "lower",
  knee_lift_max: "lower",
  stance_width: "lower",
  view_ratio: "core",
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
    case "wrist_drift":
    case "wrist_above_shoulder":
      return on((s) => s.wrist);
    case "knee_min":
    case "knee_max":
    case "knee_lift_max":
    case "knee_track":
      return on((s) => s.knee, both);
    case "torso_lean":
      return [...on((s) => s.shoulder), ...on((s) => s.hip)];
    case "hip_sag":
      return on((s) => s.hip);
    case "stance_width":
      return on((s) => s.ankle, both);
    case "view_ratio":
      return [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP];
  }
}
