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

/** Inclusive [min, max] range in degrees. */
export type AngleRange = [number, number];

export type JointAngles = Partial<Record<JointName, number>>;
export type AngleTargets = Partial<Record<JointName, AngleRange>>;

export interface RepConfig {
  /** Joints whose (averaged) angle drives the rep. */
  joints: JointName[];
  /** Whether the angle increases or decreases on the way to the peak of a rep. */
  direction: "increase" | "decrease";
  /** Angle at which the body is considered back in the starting position. */
  start_threshold: number;
  /** Angle that must be reached for the rep to count. */
  peak_threshold: number;
}

export interface Exercise {
  id: string;
  name: string;
  category: "cardio" | "strength" | "mobility";
  difficulty: "beginner" | "intermediate" | "advanced";
  duration_sec: number;
  rep_target: number;
  description: string;
  camera_setup: string;
  /** Checked on every frame. */
  ideal_angles: AngleTargets;
  /** Checked only while the user is at the peak of a rep. */
  peak_angles?: AngleTargets;
  rep: RepConfig;
  issue_messages?: Partial<Record<JointType, { low?: string; high?: string }>>;
  common_issues: string[];
  correction_tips: string[];
  voice_intro: string;
  voice_encouragement: string[];
}

export type JointStatus = "good" | "warn" | "bad";

export interface JointCheck {
  joint: JointName;
  angle: number;
  ideal: AngleRange;
  /** Degrees outside the ideal range (0 when inside). */
  deviation: number;
  /** 0 (perfect) to 1 (30°+ off). */
  severity: number;
  status: JointStatus;
  direction: "low" | "high" | null;
}

export interface ScoreBreakdown {
  upper: number | null;
  core: number | null;
  lower: number | null;
  rom: number | null;
}

export interface FrameEvaluation {
  score: number | null;
  checks: JointCheck[];
  breakdown: Omit<ScoreBreakdown, "rom">;
  worst: JointCheck | null;
}

export interface FormIssue {
  joint: JointName;
  message: string;
  status: JointStatus;
}

export type RepPhase = "start" | "moving" | "peak";

export interface RepEvent {
  type: "rep" | "partial";
  /** Range of motion achieved, 0-100. */
  rom: number;
  at: number;
}

export type DetectionStatus =
  | "idle"
  | "starting-camera"
  | "loading-model"
  | "running"
  | "paused"
  | "error";
