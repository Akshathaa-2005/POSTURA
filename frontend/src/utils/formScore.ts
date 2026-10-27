import type { FaultHit, FaultRule, Side } from "@/types";
import { LM, type Landmark } from "@/types/mediapipe";
import { MIN_VISIBILITY, PENALTY } from "./poseValidation";

/** Share of the judged limbs' landmarks (6 per side) that must be reliably visible before anything is scored. */
export const MIN_VISIBLE_FRACTION = 0.75;
/** Share of the rules applicable right now that must be measurable. */
export const MIN_COVERAGE = 0.6;
/** How long (ms) the last score stays on screen after valid frames stop (absorbs a brief dropout). */
export const SCORE_HOLD_MS = 2000;

export type ScoreSkip = "no_pose" | "low_visibility" | "not_in_position" | "idle" | "nothing_to_assess" | "low_coverage";

export interface AssessedRule {
  rule: FaultRule;
  /** Its metric could be measured this frame. Unmeasured rules are *unknown*, not "passed". */
  evaluable: boolean;
}

export interface FrameScoreInput {
  /** The metric the exercise is tracked by (rep metric or hold position) is measurable. */
  inFrame: boolean;
  visibleFraction: number;
  /** The starting position was reached (always true for exercises without one). */
  setupOk: boolean;
  /** Reps: mid-rep (not resting at the start). Holds: in position. */
  active: boolean;
  /** Live rules that apply in the current phase. */
  rules: AssessedRule[];
  /** Live faults found among the evaluable rules. */
  hits: FaultHit[];
  /** Quality of the last completed rep (0-100), once there is one. */
  repQuality: number | null;
}

export interface FrameScore {
  /** 0-100, or null when this frame can't be judged. */
  score: number | null;
  /** Share of applicable rules that were measurable (0-1). */
  coverage: number;
  skip?: ScoreSkip;
}

const SIDE_LANDMARKS = {
  left: [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE],
  right: [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST, LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
} as const;

/** Fraction of the judged sides' limb landmarks that are visible (after unreliable ones were zeroed). */
export function visibleFraction(landmarks: Landmark[], sides: Side[]): number {
  const ids = sides.flatMap((s) => SIDE_LANDMARKS[s]);
  if (!ids.length) return 0;
  return ids.filter((i) => (landmarks[i]?.visibility ?? 0) >= MIN_VISIBILITY).length / ids.length;
}

/**
 * Scores one frame, or declines to. Declining (null) is the rule, not the exception: a score is only produced when
 * the body is seen well enough, the user is actually doing the exercise, and enough of the form rules could be checked.
 * "Nothing was wrong" requires that something was looked at.
 */
export function scoreFrame(i: FrameScoreInput): FrameScore {
  const skip = (reason: ScoreSkip, coverage = 0): FrameScore => ({ score: null, coverage, skip: reason });
  if (!i.inFrame) return skip("no_pose");
  if (i.visibleFraction < MIN_VISIBLE_FRACTION) return skip("low_visibility");
  if (!i.setupOk) return skip("not_in_position");
  if (!i.active) return skip("idle");

  if (i.rules.length === 0) {
    // Nothing to check live: only a finished rep says anything about quality.
    return i.repQuality === null ? skip("nothing_to_assess") : { score: i.repQuality, coverage: 1 };
  }
  const coverage = i.rules.filter((r) => r.evaluable).length / i.rules.length;
  if (coverage < MIN_COVERAGE) return skip("low_coverage", coverage);

  const posture = Math.max(0, 100 - i.hits.reduce((s, h) => s + PENALTY[h.status], 0));
  const raw = i.repQuality === null ? posture : (posture + i.repQuality) / 2;
  // A perfect score must be earned with everything verified: unmeasured rules lower the ceiling.
  const ceiling = 100 - (1 - coverage) * 50;
  return { score: Math.min(raw, ceiling), coverage };
}
