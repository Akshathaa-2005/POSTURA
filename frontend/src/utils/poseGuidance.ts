import type { Exercise, JointAngles, JointName, JointType, Side } from "@/types";
import { FIGURE_POSES, type FigurePoint } from "./figurePoses";
import { computeAngle } from "./poseValidation";

/** Joints within this many degrees of the target count as "in position". */
export const TOLERANCE_DEG = 12;
/** Corrections are rounded to this step so a wobbling reading doesn't change the wording every update. */
const ROUND_DEG = 5;
/** How often the guidance list is refreshed (ms). */
export const GUIDANCE_INTERVAL_MS = 750;
/** Minimum gap between two spoken instructions, and before the same one is repeated (ms). */
const MIN_SPEAK_GAP_MS = 3000;
const REPEAT_SAME_MS = 8000;
/** A correction that changed by at least this much is worth re-speaking early. */
const REPEAT_IF_CHANGED_DEG = 15;
const MAX_LISTED = 4;

export interface JointInstruction {
  joint: JointName;
  /** Measured angle, degrees. */
  current: number;
  /** Angle of the target pose, degrees. */
  target: number;
  /** Signed correction (target − current), rounded. */
  delta: number;
  direction: "increase" | "decrease";
  /** Short sentence, suitable for speech and on-screen text. */
  text: string;
}

export interface GuidanceResult {
  /** Joints outside tolerance, largest correction first. */
  instructions: JointInstruction[];
  /** Number of joints that could be compared (visible and part of the target). */
  compared: number;
  /** Every compared joint is within tolerance. */
  inPosition: boolean;
}

// ---- Target pose -----------------------------------------------------------------

const FIGURE_TRIPLETS: Record<JointName, [FigurePoint, FigurePoint, FigurePoint]> = {
  left_shoulder: ["lH", "lS", "lE"],
  right_shoulder: ["rH", "rS", "rE"],
  left_elbow: ["lS", "lE", "lW"],
  right_elbow: ["rS", "rE", "rW"],
  left_hip: ["lS", "lH", "lK"],
  right_hip: ["rS", "rH", "rK"],
  left_knee: ["lH", "lK", "lA"],
  right_knee: ["rH", "rK", "rA"],
};

const JOINTS = Object.keys(FIGURE_TRIPLETS) as JointName[];

const cache = new Map<string, JointAngles | null>();

/**
 * Target joint angles for an exercise: its peak pose (the figure keyframe the 3D avatar and
 * the pose guides are built from), measured with the same joint definitions as the live angles.
 */
export function targetAngles(exerciseId: string): JointAngles | null {
  if (cache.has(exerciseId)) return cache.get(exerciseId)!;
  const peak = FIGURE_POSES[exerciseId]?.[1];
  let result: JointAngles | null = null;
  if (peak) {
    result = {};
    for (const joint of JOINTS) {
      const [a, b, c] = FIGURE_TRIPLETS[joint].map((k) => ({ x: peak[k][0], y: peak[k][1], z: 0, visibility: 1 }));
      result[joint] = computeAngle(a, b, c, 1, 1);
    }
  }
  cache.set(exerciseId, result);
  return result;
}

// ---- Instructions ----------------------------------------------------------------

const VERBS: Record<JointType, { increase: string; decrease: string }> = {
  elbow: { increase: "Straighten", decrease: "Bend" },
  knee: { increase: "Straighten", decrease: "Bend" },
  hip: { increase: "Open", decrease: "Close" },
  shoulder: { increase: "Raise", decrease: "Lower" },
};

const OBJECT: Record<JointType, string> = {
  elbow: "elbow",
  knee: "knee",
  hip: "hip",
  shoulder: "arm",
};

function describe(joint: JointName, delta: number): string {
  const [side, type] = joint.split("_") as [Side, JointType];
  const dir = delta > 0 ? "increase" : "decrease";
  return `${VERBS[type][dir]} your ${side} ${OBJECT[type]} about ${Math.abs(delta)} degrees.`;
}

/**
 * Compares the live joint angles with the target pose.
 * `sides` limits the comparison to the limbs the camera can actually see (one side in side view).
 */
export function computeGuidance(
  current: JointAngles,
  target: JointAngles,
  sides: Side[] = ["left", "right"],
): GuidanceResult {
  const instructions: JointInstruction[] = [];
  let compared = 0;
  for (const joint of JOINTS) {
    if (!sides.includes(joint.split("_")[0] as Side)) continue;
    const cur = current[joint];
    const tgt = target[joint];
    if (cur === undefined || tgt === undefined) continue;
    compared += 1;
    const raw = tgt - cur;
    if (Math.abs(raw) <= TOLERANCE_DEG) continue;
    const delta = Math.round(raw / ROUND_DEG) * ROUND_DEG;
    instructions.push({
      joint,
      current: Math.round(cur),
      target: Math.round(tgt),
      delta,
      direction: delta > 0 ? "increase" : "decrease",
      text: describe(joint, delta),
    });
  }
  instructions.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { instructions: instructions.slice(0, MAX_LISTED), compared, inPosition: compared > 0 && instructions.length === 0 };
}

export function guidanceFor(exercise: Exercise, current: JointAngles, sides?: Side[]): GuidanceResult | null {
  const target = targetAngles(exercise.id);
  return target ? computeGuidance(current, target, sides) : null;
}

// ---- Pacing ----------------------------------------------------------------------

/**
 * Decides what to *say*, so the user isn't flooded: one instruction at a time, a minimum gap
 * between utterances, no repeating the same correction unless it has lingered or changed a lot,
 * and a single "hold it" when the pose is reached.
 */
export class SpeechPacer {
  private lastAt = -Infinity;
  private last: { joint: JointName; delta: number; at: number } | null = null;
  private announcedInPosition = false;

  reset(): void {
    this.lastAt = -Infinity;
    this.last = null;
    this.announcedInPosition = false;
  }

  /** Returns the sentence to speak now, or null. */
  next(result: GuidanceResult, now: number): string | null {
    if (result.compared === 0) return null;
    if (result.inPosition) {
      this.last = null;
      if (this.announcedInPosition || now - this.lastAt < MIN_SPEAK_GAP_MS) return null;
      this.announcedInPosition = true;
      this.lastAt = now;
      return "Good. Hold this position.";
    }
    this.announcedInPosition = false;
    if (now - this.lastAt < MIN_SPEAK_GAP_MS) return null;
    const top = result.instructions[0];
    const prev = this.last;
    const same = prev?.joint === top.joint && Math.sign(prev.delta) === Math.sign(top.delta);
    if (same && now - prev!.at < REPEAT_SAME_MS && Math.abs(top.delta - prev!.delta) < REPEAT_IF_CHANGED_DEG) return null;
    this.lastAt = now;
    this.last = { joint: top.joint, delta: top.delta, at: now };
    return top.text;
  }
}
