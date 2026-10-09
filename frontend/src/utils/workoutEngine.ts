import type {
  Exercise,
  FormIssue,
  FrameEvaluation,
  JointAngles,
  JointCheck,
  JointStatus,
  RepEvent,
  RepPhase,
  ScoreBreakdown,
} from "@/types";
import type { Landmark } from "@/types/mediapipe";
import { computeJointAngles, evaluateFrame, issueMessage, JOINT_TRIPLETS } from "./poseValidation";
import { RepCounter } from "./repCounter";

/** Weight of the newest sample in the exponential moving averages. */
const LANDMARK_SMOOTHING = 0.6;
const ANGLE_SMOOTHING = 0.5;
const SCORE_SMOOTHING = 0.15;
/** An issue must persist this long before it's shown (avoids flicker)… */
const ISSUE_SHOW_MS = 300;
/** …and form must stay clean this long before it's cleared. */
const ISSUE_CLEAR_MS = 600;

export interface EngineSnapshot {
  landmarks: Landmark[] | null;
  /** Landmark index → status, for colouring the skeleton. */
  jointStatus: Map<number, JointStatus>;
  angles: JointAngles;
  evaluation: FrameEvaluation | null;
  /** Rep-driving joints are visible, so tracking is meaningful. */
  inFrame: boolean;
  score: number | null;
  breakdown: ScoreBreakdown;
  averageScore: number | null;
  reps: number;
  phase: RepPhase;
  repEvent: RepEvent | null;
  issue: FormIssue | null;
}

const ema = (prev: number | undefined, next: number, alpha: number) =>
  prev === undefined ? next : prev + alpha * (next - prev);

export class WorkoutEngine {
  private readonly counter: RepCounter;
  private smoothed: Landmark[] | null = null;
  private smoothedAngles: JointAngles = {};
  private score: number | null = null;
  private breakdown: ScoreBreakdown = { upper: null, core: null, lower: null, rom: null };
  private scoreSum = 0;
  private scoreFrames = 0;

  private issue: FormIssue | null = null;
  private pending: { check: JointCheck; since: number } | null = null;
  private cleanSince: number | null = null;

  constructor(private readonly exercise: Exercise) {
    this.counter = new RepCounter(exercise.rep);
  }

  process(raw: Landmark[] | null, width: number, height: number, now: number): EngineSnapshot {
    if (!raw) {
      this.smoothed = null;
      return this.snapshot(null, {}, null, false, null);
    }

    this.smoothed = raw.map((p, i) => {
      const prev = this.smoothed?.[i];
      return prev
        ? {
            x: ema(prev.x, p.x, LANDMARK_SMOOTHING),
            y: ema(prev.y, p.y, LANDMARK_SMOOTHING),
            z: ema(prev.z, p.z, LANDMARK_SMOOTHING),
            visibility: p.visibility,
          }
        : p;
    });

    const angles = computeJointAngles(this.smoothed, width, height);
    for (const [joint, angle] of Object.entries(angles) as [keyof JointAngles, number][]) {
      this.smoothedAngles[joint] = ema(this.smoothedAngles[joint], angle, ANGLE_SMOOTHING);
      angles[joint] = this.smoothedAngles[joint];
    }

    const repAngles = this.exercise.rep.joints.map((j) => angles[j]).filter((a): a is number => a !== undefined);
    const inFrame = repAngles.length > 0;
    let repEvent: RepEvent | null = null;
    if (inFrame) {
      repEvent = this.counter.update(repAngles.reduce((s, a) => s + a, 0) / repAngles.length, now);
      if (repEvent) this.breakdown.rom = repEvent.rom;
    }

    const evaluation = evaluateFrame(angles, this.exercise, this.counter.phase);
    if (evaluation.score !== null) {
      this.score = this.score === null ? evaluation.score : ema(this.score, evaluation.score, SCORE_SMOOTHING);
      this.scoreSum += evaluation.score;
      this.scoreFrames += 1;
      for (const part of ["upper", "core", "lower"] as const) {
        const v = evaluation.breakdown[part];
        if (v !== null) this.breakdown[part] = ema(this.breakdown[part] ?? undefined, v, SCORE_SMOOTHING);
      }
    }
    this.updateIssue(evaluation.worst, now);

    return this.snapshot(this.smoothed, angles, evaluation, inFrame, repEvent);
  }

  private updateIssue(worst: JointCheck | null, now: number) {
    if (!worst) {
      this.pending = null;
      this.cleanSince ??= now;
      if (this.issue && now - this.cleanSince >= ISSUE_CLEAR_MS) this.issue = null;
      return;
    }
    this.cleanSince = null;

    if (this.issue?.joint === worst.joint) {
      // Same issue still present: keep message/status fresh.
      this.issue = { joint: worst.joint, status: worst.status, message: issueMessage(worst, this.exercise) };
      return;
    }
    if (this.pending?.check.joint !== worst.joint) {
      this.pending = { check: worst, since: now };
    } else if (now - this.pending.since >= ISSUE_SHOW_MS) {
      this.issue = { joint: worst.joint, status: worst.status, message: issueMessage(worst, this.exercise) };
      this.pending = null;
    }
  }

  private snapshot(
    landmarks: Landmark[] | null,
    angles: JointAngles,
    evaluation: FrameEvaluation | null,
    inFrame: boolean,
    repEvent: RepEvent | null,
  ): EngineSnapshot {
    const jointStatus = new Map<number, JointStatus>();
    for (const check of evaluation?.checks ?? []) {
      jointStatus.set(JOINT_TRIPLETS[check.joint][1], check.status);
    }
    return {
      landmarks,
      jointStatus,
      angles,
      evaluation,
      inFrame,
      score: this.score,
      breakdown: { ...this.breakdown },
      averageScore: this.scoreFrames ? this.scoreSum / this.scoreFrames : null,
      reps: this.counter.reps,
      phase: this.counter.phase,
      repEvent,
      issue: this.issue,
    };
  }
}
