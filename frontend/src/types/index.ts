export type JointName =
  | "left_shoulder"
  | "right_shoulder"
  | "left_elbow"
  | "right_elbow"
  | "left_hip"
  | "right_hip"
  | "left_knee"
  | "right_knee";

export type JointType = "shoulder" | "elbow" | "hip" | "knee";
export type Side = "left" | "right";

/** Inclusive [min, max] range in degrees. */
export type AngleRange = [number, number];

export type JointAngles = Partial<Record<JointName, number>>;

/**
 * Measurements a fault or rep can be based on.
 * Sided metrics are evaluated per body side (front view: both; side view: the side facing the camera).
 */
export type SidedMetric = JointType | "hands_overhead";
export type GlobalMetric =
  | "torso_lean"
  | "hip_sag"
  | "stance_width"
  | "knee_min"
  | "knee_max"
  | "knee_track"
  | "knee_lift_max";
export type MetricName = SidedMetric | GlobalMetric;

export interface RepConfig {
  metric: MetricName;
  /** Whether the metric increases or decreases on the way to the peak of a rep. */
  direction: "increase" | "decrease";
  /** Value at which the body is considered back in the starting position. */
  start_threshold: number;
  /** Value that must be reached for the rep to count. */
  peak_threshold: number;
}

export interface FaultRule {
  id: string;
  label: string;
  /** always: every frame · active: while moving/at the peak · peak: at the peak · rep: once per rep, on the rep's min/max */
  when: "always" | "active" | "peak" | "rep";
  metric: MetricName;
  agg?: "min" | "max";
  /** The fault is present when `metric op warn` holds; it is major when `metric op bad` also holds. */
  op: "<" | ">";
  warn: number;
  bad?: number;
  cue: string;
  /** Used instead of `cue` when only one side is at fault (front view). `{side}` → left/right. */
  cue_side?: string;
  /**
   * A rep-level rule that must be measurable for a rep to count. If the metric can't be seen during the rep
   * (for example the feet are out of frame), the rep is not counted and `unseen_cue` is shown instead.
   */
  required?: boolean;
  unseen_cue?: string;
}

export interface SetupRule {
  metric: MetricName;
  op: "<" | ">";
  value: number;
  cue: string;
}

export interface Exercise {
  id: string;
  name: string;
  category: "cardio" | "strength" | "core" | "mobility";
  difficulty: "beginner" | "intermediate" | "advanced";
  duration_sec: number;
  rep_target: number;
  description: string;
  camera_setup: string;
  view: "front" | "side";
  /** "reps" counts repetitions; "hold" times how long the setup position is held with good form. */
  mode?: "reps" | "hold";
  /** Hold exercises: target seconds. */
  hold_target_sec?: number;
  /** Starting position that must hold before reps and faults are evaluated (required for holds). */
  setup?: SetupRule;
  /** Rep exercises only. */
  rep?: RepConfig;
  faults: FaultRule[];
  correction_tips: string[];
  voice_intro: string;
  voice_encouragement: string[];
}

export type JointStatus = "good" | "warn" | "bad";

export interface FaultHit {
  rule: FaultRule;
  status: Exclude<JointStatus, "good">;
  /** Side(s) at fault, for sided metrics. */
  sides: Side[];
  value: number;
}

export interface ScoreBreakdown {
  upper: number | null;
  core: number | null;
  lower: number | null;
  rom: number | null;
}

export interface FormIssue {
  /** Fault id, or "setup" when the user isn't in the starting position. */
  id: string;
  label: string;
  message: string;
  status: Exclude<JointStatus, "good">;
  side: Side | null;
  /** Detected from the last rep (depth/range) rather than live posture. */
  fromRep: boolean;
}

export type RepPhase = "start" | "moving" | "peak";

/** One rep's normalised skeleton (see src/ml/skeleton.ts), for recording and for the form model. */
export interface RepWindow {
  frames: number;
  /** frames × 17 joints × (x, y, visibility), flattened. */
  joints: Float64Array;
  /** frames × (cos tilt, sin tilt, torso valid), flattened. */
  context: Float64Array;
}

export interface RepEvent {
  /** "partial" = not counted: the rep fell short or had a major fault. */
  type: "rep" | "partial";
  /** Range of motion achieved, 0-100. */
  rom: number;
  at: number;
  /** Faults found in this rep, major first (empty = a clean rep). */
  faults: FaultHit[];
  /** Why a rep wasn't counted when no fault explains it. */
  note?: string;
  /** The rep's skeleton, when it could be captured cleanly. */
  window?: RepWindow;
}

export type DetectionStatus =
  | "idle"
  | "starting-camera"
  | "loading-model"
  | "running"
  | "paused"
  | "error";

export * from "./avatar";

