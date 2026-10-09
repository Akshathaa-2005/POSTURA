import type {
  AngleRange,
  AngleTargets,
  Exercise,
  FrameEvaluation,
  JointAngles,
  JointCheck,
  JointName,
  JointType,
  RepPhase,
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

const BODY_PART: Record<JointType, "upper" | "core" | "lower"> = {
  shoulder: "upper",
  elbow: "upper",
  hip: "core",
  knee: "lower",
};

/** Deviation (degrees) at which a joint scores 0. */
const MAX_DEVIATION = 30;
/** Deviation (degrees) below which an issue is "minor" (yellow) rather than "major" (red). */
const WARN_DEVIATION = 15;

export const MIN_VISIBILITY = 0.5;

export function jointType(joint: JointName): JointType {
  return joint.split("_")[1] as JointType;
}

export function jointSide(joint: JointName): "left" | "right" {
  return joint.split("_")[0] as "left" | "right";
}

/** Angle ABC in degrees (0-180), measured in pixel space so non-square frames don't skew it. */
export function computeAngle(a: Landmark, b: Landmark, c: Landmark, width: number, height: number): number {
  const abx = (a.x - b.x) * width;
  const aby = (a.y - b.y) * height;
  const cbx = (c.x - b.x) * width;
  const cby = (c.y - b.y) * height;
  const dot = abx * cbx + aby * cby;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (mag === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180) / Math.PI;
}

/** Joint angles for every joint whose three landmarks are confidently visible. */
export function computeJointAngles(landmarks: Landmark[], width: number, height: number): JointAngles {
  const angles: JointAngles = {};
  for (const joint of JOINT_NAMES) {
    const [ia, ib, ic] = JOINT_TRIPLETS[joint];
    const pts = [landmarks[ia], landmarks[ib], landmarks[ic]];
    if (pts.some((p) => !p || (p.visibility ?? 1) < MIN_VISIBILITY)) continue;
    angles[joint] = computeAngle(pts[0], pts[1], pts[2], width, height);
  }
  return angles;
}

export function checkJoint(joint: JointName, angle: number, ideal: AngleRange): JointCheck {
  const [min, max] = ideal;
  const direction = angle < min ? "low" : angle > max ? "high" : null;
  const deviation = direction === "low" ? min - angle : direction === "high" ? angle - max : 0;
  const severity = Math.min(1, deviation / MAX_DEVIATION);
  const status = deviation === 0 ? "good" : deviation < WARN_DEVIATION ? "warn" : "bad";
  return { joint, angle, ideal, deviation, severity, status, direction };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/**
 * Scores a single frame. `ideal_angles` apply on every frame; `peak_angles`
 * only while the user is at the peak of a rep (and override ideal ranges there).
 */
export function evaluateFrame(angles: JointAngles, exercise: Exercise, phase: RepPhase): FrameEvaluation {
  const targets: AngleTargets = {
    ...exercise.ideal_angles,
    ...(phase === "peak" ? exercise.peak_angles : undefined),
  };

  const checks: JointCheck[] = [];
  for (const [joint, ideal] of Object.entries(targets) as [JointName, AngleRange][]) {
    const angle = angles[joint];
    if (angle !== undefined) checks.push(checkJoint(joint, angle, ideal));
  }

  const jointScore = (c: JointCheck) => 100 * (1 - c.severity);
  const part = (p: "upper" | "core" | "lower") =>
    mean(checks.filter((c) => BODY_PART[jointType(c.joint)] === p).map(jointScore));

  const worst = checks.reduce<JointCheck | null>(
    (w, c) => (c.severity > 0 && (!w || c.severity > w.severity) ? c : w),
    null,
  );

  return {
    score: mean(checks.map(jointScore)),
    checks,
    breakdown: { upper: part("upper"), core: part("core"), lower: part("lower") },
    worst,
  };
}

const DEFAULT_MESSAGES: Record<JointType, { low: string; high: string }> = {
  shoulder: { low: "Raise your {side} arm higher", high: "Lower your {side} arm a little" },
  elbow: { low: "Straighten your {side} arm more", high: "Bend your {side} elbow more" },
  hip: { low: "Open up your {side} hip, keep your chest up", high: "Hinge more at the hips" },
  knee: { low: "Straighten your {side} leg more", high: "Bend your {side} knee more" },
};

export function issueMessage(check: JointCheck, exercise: Exercise): string {
  const type = jointType(check.joint);
  const dir = check.direction ?? "low";
  const template = exercise.issue_messages?.[type]?.[dir] ?? DEFAULT_MESSAGES[type][dir];
  return template.replace("{side}", jointSide(check.joint));
}
