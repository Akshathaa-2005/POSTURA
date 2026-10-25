import type {
  Exercise,
  FaultHit,
  FaultRule,
  FormIssue,
  JointAngles,
  JointStatus,
  RepEvent,
  RepNoteId,
  RepPhase,
  RepQuality,
  ScoreBreakdown,
  Side,
} from "@/types";
import type { Landmark } from "@/types/mediapipe";
import {
  computeJointAngles,
  computeMetrics,
  evaluateRule,
  faultMessage,
  METRIC_REGION,
  metricLandmarks,
  metricValues,
  PENALTY,
  setupSatisfied,
  sideVisibility,
  sideLandmarks,
  usableAt,
  type BodyRegion,
  type FrameMetrics,
  type MetricValue,
} from "./poseValidation";
import { RepCounter } from "./repCounter";
import { RepRecorder } from "../ml/recorder";

/** Weight of the newest sample in the exponential moving averages. */
const LANDMARK_SMOOTHING = 0.6;
const METRIC_SMOOTHING = 0.5;
const SCORE_SMOOTHING = 0.15;
/** A live fault must persist this long before it's shown or coached (avoids flicker)… */
const FAULT_CONFIRM_MS = 400;
/** …and be gone this long before it's cleared. */
const FAULT_CLEAR_MS = 700;
/** The starting-position hint waits a little so it doesn't flash while people get set. */
const SETUP_CONFIRM_MS = 1200;
/** Rep faults stay on screen until the next rep, or this long. */
const REP_ISSUE_MS = 5000;
/** How long rep-fault joints stay highlighted after the rep. */
const REP_HIGHLIGHT_MS = 1500;
/** Switch the tracked side (side view) only when the other side is clearly more visible. */
const SIDE_SWITCH_MARGIN = 0.08;
/**
 * Camera orientation. Side-view exercises need the camera to see you from the side (shoulders overlap, ratio near 0);
 * front-view ones need you to face it. Every check assumes the right view, so reps aren't judged in the wrong one.
 * Two thresholds per view give hysteresis, so a borderline stance doesn't flicker.
 */
const VIEW_SIDE_WRONG_ABOVE = 0.55;
const VIEW_SIDE_OK_BELOW = 0.45;
const VIEW_FRONT_WRONG_BELOW = 0.2;
const VIEW_FRONT_OK_ABOVE = 0.28;
/** A major live fault held this many frames during a rep means the rep doesn't count. */
const REP_BAD_FRAMES = 3;
/** A rep doesn't count if the body was out of frame (or out of position) for more than this share of it. */
const MAX_LOST_FRACTION = 0.3;
/** The start position is judged this long before the rep leaves the start phase… */
const START_LOOKBACK_MS = 300;
/** …from results kept for this long. */
const START_LOG_MS = 1000;
/** Strength, core and mobility reps faster than this are bounces, not controlled reps. Cardio is exempt. */
const DEFAULT_MIN_REP_MS = 400;
/** A swing back by this share of the range of motion counts as a direction change. */
const REVERSAL_HYSTERESIS = 0.3;
/** Weight of the newest sample when smoothing the rep's progress before counting direction changes. */
const PROGRESS_SMOOTHING = 0.5;
/** Landmark jitter can fake one back-and-forth; a rep is only a stall or bounce with at least this many extra turns. */
const STALL_REVERSALS = 2;
/** The needed body parts must be missing this many frames in a row (~0.25 s) before counting pauses. */
const UNFRAMED_FRAMES = 8;
/** Smoothness lost per extra direction change. */
const REVERSAL_PENALTY = 35;
/** Praise every Nth consecutive clean rep… */
const PRAISE_EVERY = 3;
/** …or every this-many seconds of a clean hold. */
const HOLD_PRAISE_MS = 10_000;
/** Longest gap between frames counted towards a hold (e.g. a dropped frame, not a pause). */
const MAX_FRAME_GAP_MS = 250;

const NOTE_LABEL: Record<RepNoteId, string> = {
  unseen: "Can't see you",
  lost: "Left the frame",
  rushed: "Too fast",
  stalled: "Not smooth",
  start: "Start position",
};

export interface EngineSnapshot {
  landmarks: Landmark[] | null;
  /** Landmark index → status, for colouring the skeleton. */
  jointStatus: Map<number, JointStatus>;
  angles: JointAngles;
  /** The rep metric is measurable, so tracking is meaningful. */
  inFrame: boolean;
  setupOk: boolean;
  score: number | null;
  breakdown: ScoreBreakdown;
  averageScore: number | null;
  reps: number;
  /** Hold exercises: time held in position without a major fault. */
  holdMs: number;
  phase: RepPhase;
  repEvent: RepEvent | null;
  /** The cue currently shown to the user. */
  issue: FormIssue | null;
  /** Set on the frame a cue becomes worth speaking (new live fault, faulty rep, setup hint). */
  coachIssue: FormIssue | null;
  /** Set on the frame a run of clean reps deserves encouragement. */
  praise: boolean;
}

const ema = (prev: number | undefined, next: number, alpha: number) =>
  prev === undefined ? next : prev + alpha * (next - prev);

const severityRank = (s: JointStatus) => (s === "bad" ? 2 : s === "warn" ? 1 : 0);

export class WorkoutEngine {
  private readonly hold: boolean;
  private readonly counter: RepCounter | null;
  private readonly liveRules: FaultRule[];
  private readonly repRules: FaultRule[];
  private readonly regions: Set<BodyRegion>;

  private smoothed: Landmark[] | null = null;
  private smoothedAngles: JointAngles = {};
  private smoothedMetrics = new Map<string, number>();
  private side: Side = "left";

  private score: number | null = null;
  private breakdown: ScoreBreakdown = { upper: null, core: null, lower: null, rom: null };
  private scoreSum = 0;
  private scoreFrames = 0;
  private lastRepQuality: number | null = null;

  /** Per-rep min/max of each rep-rule metric, keyed `${metric}:${side}`. */
  private repAgg = new Map<string, { min: number; max: number; side: Side | null }>();
  private repLiveBad = new Map<string, { hit: FaultHit; frames: number }>();
  private repFrames = 0;
  private repLostFrames = 0;
  private repHits: FaultHit[] = [];
  private repHitsAt = -Infinity;
  /** The rep metric's progress (0 = start, 1 = peak) over the current rep, to judge how it was performed. */
  private repTrack: { t: number; p: number }[] = [];
  private cleanStreak = 0;

  private liveSince = new Map<string, number>();
  private liveLast = new Map<string, { hit: FaultHit; at: number }>();
  private setupFailSince: number | null = null;
  private lastIssueKey: string | null = null;
  private readonly recorder = new RepRecorder();
  /** Why the last rep couldn't be judged (body or feet out of frame), shown until the next rep. */
  private seenProblem: { id: RepNoteId; message: string; at: number } | null = null;
  private wrongView = false;
  /** The body parts this exercise needs are all inside the frame (see `Exercise.body_scope`). */
  private framed = true;
  private unframedFrames = 0;
  /** Whether the body was in the right place (`rep.start_check`) at its most rested before the rep. */
  private startHeld = true;
  /** Start-check results from the last second spent in the start phase, newest last. */
  private startLog: { t: number; ok: boolean }[] = [];
  private lastDebugAt = -Infinity;

  private holdMs = 0;
  private lastFrameAt: number | null = null;
  private nextHoldPraiseMs = HOLD_PRAISE_MS;

  constructor(private readonly exercise: Exercise) {
    this.hold = exercise.mode === "hold";
    if (this.hold && !exercise.setup) throw new Error(`Hold exercise ${exercise.id} needs a setup rule`);
    if (!this.hold && !exercise.rep) throw new Error(`Rep exercise ${exercise.id} needs a rep config`);
    this.counter = exercise.rep && !this.hold ? new RepCounter(exercise.rep) : null;
    this.liveRules = exercise.faults.filter((f) => f.when !== "rep");
    this.repRules = exercise.faults.filter((f) => f.when === "rep");
    this.regions = new Set(exercise.faults.map((f) => METRIC_REGION[f.metric]));
  }

  process(raw: Landmark[] | null, width: number, height: number, now: number): EngineSnapshot {
    const dt = this.lastFrameAt === null ? 0 : Math.min(MAX_FRAME_GAP_MS, now - this.lastFrameAt);
    this.lastFrameAt = now;
    if (!raw) {
      if (process.env.NODE_ENV !== "production" && now - this.lastDebugAt >= 2000) {
        this.lastDebugAt = now;
        console.info("[track] MediaPipe returned no pose for this frame (nobody detected, or too close / too cropped)");
      }
      if (this.counter && this.counter.phase !== "start") this.repLostFrames += 1;
      this.smoothed = null;
      this.setupFailSince = null;
      return this.snapshot({ landmarks: null, angles: {}, inFrame: false, setupOk: true, jointStatus: new Map() });
    }

    // 1. Smooth landmarks and angles.
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
    const lm = this.smoothed;
    const angles = computeJointAngles(lm, width, height);
    for (const [joint, angle] of Object.entries(angles) as [keyof JointAngles, number][]) {
      angles[joint] = this.smoothedAngles[joint] = ema(this.smoothedAngles[joint], angle, METRIC_SMOOTHING);
    }

    // 2. Decide which side(s) to judge. In side view the far limbs are guessed by the model, so ignore them.
    const sides = this.pickSides(lm);
    const metrics = this.smoothMetrics(computeMetrics(lm, width, height, angles, sides));
    const viewOk = this.checkView(metrics);
    const setupOk = setupSatisfied(this.exercise.setup, metrics) && viewOk;

    // 3. Reps (only once the starting position is held). Holds are "in frame" when their position is measurable.
    const trackedMetric = this.counter ? this.exercise.rep!.metric : this.exercise.setup!.metric;
    const repValues = metricValues(metrics, trackedMetric);
    if (process.env.NODE_ENV !== "production" && now - this.lastDebugAt >= 500) {
      this.lastDebugAt = now;
      const avg = repValues.length ? repValues.reduce((s, v) => s + v.value, 0) / repValues.length : null;
      console.info("[track]", this.exercise.id, {
        [trackedMetric]: avg === null ? "not measurable" : Math.round(avg),
        progress: avg === null || !this.counter ? null : Number(this.counter.progress(avg).toFixed(2)),
        phase: this.counter?.phase,
        framed: this.framed,
        wrongView: this.wrongView,
        setupOk,
        side: sides.join("+"),
        viewRatio: metrics.global.view_ratio === undefined ? "n/a" : Number(metrics.global.view_ratio.toFixed(2)),
      });
    }
    this.unframedFrames = this.bodyFramed(lm, sides) ? 0 : this.unframedFrames + 1;
    this.framed = this.unframedFrames < UNFRAMED_FRAMES;
    const inFrame = repValues.length > 0 && this.framed;
    let repEvent: RepEvent | null = null;
    if (this.counter && inFrame && setupOk) {
      const startCheck = this.exercise.rep?.start_check;
      const wasStart = this.counter.phase === "start";
      if (startCheck && wasStart) {
        const values = metricValues(metrics, startCheck.metric);
        this.startLog.push({ t: now, ok: values.length === 0 || setupSatisfied(startCheck, metrics) }); // can't tell: don't block
        while (this.startLog[0] && now - this.startLog[0].t > START_LOG_MS) this.startLog.shift();
      }
      const count = this.counter.update(repValues.reduce((s, v) => s + v.value, 0) / repValues.length, now);
      this.recorder.push(raw, width, height, this.counter.phase !== "start" || count !== null);
      if (startCheck && wasStart && this.counter.phase !== "start") {
        // The arm already moves a little before the rep begins, so judge the position from just before the movement.
        const before = this.startLog.filter((e) => e.t <= now - START_LOOKBACK_MS).pop() ?? this.startLog[0];
        this.startHeld = before?.ok ?? true;
        this.startLog = [];
      }
      if (this.counter.phase !== "start") {
        this.aggregateRep(metrics);
        this.repFrames += 1;
        this.repTrack.push({ t: now, p: this.counter.progress(repValues.reduce((s, v) => s + v.value, 0) / repValues.length) });
      }
      if (count) {
        repEvent = this.judgeRep(count);
        repEvent.window = this.recorder.finish() ?? undefined;
        this.onRep(repEvent, now);
        if (repEvent.note && !repEvent.faults.some((f) => f.status === "bad")) {
          this.seenProblem = { id: repEvent.noteId ?? "unseen", message: repEvent.note, at: now };
        }
      } else if (this.counter.phase === "start") {
        this.resetRep();
        this.recorder.discard();
      }
    } else if (this.counter && this.counter.phase !== "start") {
      // Keep what was measured so far; leaving the frame mid-rep must not wipe the evidence.
      this.repLostFrames += 1;
    }

    // 4. Live posture faults. While holding a position, "active" and "peak" rules apply.
    const phase: RepPhase = this.counter ? this.counter.phase : setupOk ? "peak" : "start";
    const liveHits: FaultHit[] = [];
    if (inFrame && setupOk) {
      for (const rule of this.liveRules) {
        if (rule.when === "active" && phase === "start") continue;
        if (rule.when === "peak" && phase !== "peak") continue;
        const hit = evaluateRule(rule, metricValues(metrics, rule.metric));
        if (hit) liveHits.push(hit);
      }
    }
    const confirmedLive = this.trackLive(liveHits, now);
    if (this.counter && this.counter.phase !== "start") {
      for (const hit of liveHits) {
        if (hit.status !== "bad") continue;
        const seen = this.repLiveBad.get(hit.rule.id);
        this.repLiveBad.set(hit.rule.id, { hit, frames: (seen?.frames ?? 0) + 1 });
      }
    }

    // Holds: time only counts while in position without a major fault.
    let holdPraise = false;
    if (this.hold && inFrame && setupOk && !confirmedLive.some((h) => h.status === "bad")) {
      this.holdMs += dt;
      if (this.holdMs >= this.nextHoldPraiseMs) {
        this.nextHoldPraiseMs += HOLD_PRAISE_MS;
        holdPraise = confirmedLive.length === 0;
      }
    }

    // 5. Score.
    if (inFrame && setupOk) {
      const posture = Math.max(0, 100 - liveHits.reduce((s, h) => s + PENALTY[h.status], 0));
      const frameScore = this.lastRepQuality === null ? posture : (posture + this.lastRepQuality) / 2;
      this.score = ema(this.score ?? undefined, frameScore, SCORE_SMOOTHING);
      this.scoreSum += frameScore;
      this.scoreFrames += 1;
      const repHits = now - this.repHitsAt < REP_ISSUE_MS ? this.repHits : [];
      for (const region of ["upper", "core", "lower"] as const) {
        if (!this.regions.has(region)) continue;
        const penalty = [...liveHits, ...repHits]
          .filter((h) => METRIC_REGION[h.rule.metric] === region)
          .reduce((s, h) => s + PENALTY[h.status], 0);
        this.breakdown[region] = ema(this.breakdown[region] ?? undefined, Math.max(0, 100 - penalty), SCORE_SMOOTHING);
      }
    }

    // 6. Pick the cue to show, and whether it's new enough to speak.
    const issue = this.chooseIssue(confirmedLive, setupOk, inFrame, now);
    let coachIssue: FormIssue | null = null;
    const key = issue ? `${issue.id}:${issue.fromRep ? this.repHitsAt : "live"}` : null;
    if (issue && key !== this.lastIssueKey) coachIssue = issue;
    this.lastIssueKey = key;

    const praise =
      holdPraise ||
      (!!repEvent && repEvent.type === "rep" && repEvent.faults.length === 0 && this.cleanStreak % PRAISE_EVERY === 0);

    return this.snapshot({
      landmarks: lm,
      angles,
      inFrame,
      setupOk,
      jointStatus: this.jointStatus(sides, liveHits, now),
      repEvent,
      issue,
      coachIssue,
      praise,
    });
  }

  /** Whether every landmark the exercise depends on is detected and inside the frame, for the judged side(s). */
  private bodyFramed(lm: Landmark[], sides: Side[]): boolean {
    const parts = this.exercise.body_scope === "upper" ? (["shoulder", "elbow", "wrist"] as const) : (["shoulder", "hip", "knee", "ankle"] as const);
    return sides.every((side) => parts.every((part) => usableAt(lm, sideLandmarks(side)[part])));
  }

  /** True unless the camera clearly sees the body from the wrong direction for this exercise. */
  private checkView(metrics: FrameMetrics): boolean {
    const ratio = metrics.global.view_ratio;
    if (ratio === undefined || this.hold) {
      // Not measurable (the far shoulder is hidden, as it usually is side-on) must never block a workout.
      this.wrongView = false;
      return true;
    }
    if (this.exercise.view === "side") {
      this.wrongView = this.wrongView ? ratio > VIEW_SIDE_OK_BELOW : ratio > VIEW_SIDE_WRONG_ABOVE;
    } else {
      this.wrongView = this.wrongView ? ratio < VIEW_FRONT_OK_ABOVE : ratio < VIEW_FRONT_WRONG_BELOW;
    }
    return !this.wrongView;
  }

  private pickSides(lm: Landmark[]): Side[] {
    if (this.exercise.view === "front") return ["left", "right"];
    const l = sideVisibility(lm, "left");
    const r = sideVisibility(lm, "right");
    if (this.side === "left" && r > l + SIDE_SWITCH_MARGIN) this.side = "right";
    else if (this.side === "right" && l > r + SIDE_SWITCH_MARGIN) this.side = "left";
    return [this.side];
  }

  private smoothMetrics(m: FrameMetrics): FrameMetrics {
    for (const [metric, bySide] of Object.entries(m.sided)) {
      for (const [side, v] of Object.entries(bySide) as [Side, number][]) {
        const key = `${metric}:${side}`;
        const s = ema(this.smoothedMetrics.get(key), v, METRIC_SMOOTHING);
        this.smoothedMetrics.set(key, s);
        bySide[side] = s;
      }
    }
    for (const [metric, v] of Object.entries(m.global) as [keyof FrameMetrics["global"], number][]) {
      const s = ema(this.smoothedMetrics.get(metric), v, METRIC_SMOOTHING);
      this.smoothedMetrics.set(metric, s);
      m.global[metric] = s;
    }
    return m;
  }

  private aggregateRep(m: FrameMetrics) {
    for (const rule of this.repRules) {
      for (const { side, value } of metricValues(m, rule.metric)) {
        const key = `${rule.metric}:${side}`;
        const agg = this.repAgg.get(key);
        if (agg) {
          agg.min = Math.min(agg.min, value);
          agg.max = Math.max(agg.max, value);
        } else {
          this.repAgg.set(key, { min: value, max: value, side });
        }
      }
    }
  }

  /** A rep counts only if it reached the target, had no major fault, and stayed in view. */
  private judgeRep(count: Omit<RepEvent, "faults">): RepEvent {
    const unseen = this.repRules.find(
      (r) => r.required && ![...this.repAgg.keys()].some((k) => k.startsWith(`${r.metric}:`)),
    );
    const faults = this.evaluateRep();
    for (const [id, { hit, frames }] of this.repLiveBad) {
      if (frames >= REP_BAD_FRAMES && !faults.some((f) => f.rule.id === id)) faults.push(hit);
    }
    faults.sort((a, b) => severityRank(b.status) - severityRank(a.status));
    const lost = this.repLostFrames > (this.repFrames + this.repLostFrames) * MAX_LOST_FRACTION;
    const quality = this.repQuality();
    const minMs = this.exercise.rep?.min_duration_ms ?? (this.exercise.category === "cardio" ? 0 : DEFAULT_MIN_REP_MS);
    const rushed = quality.durationMs < minMs;
    const badStart = !this.startHeld;
    const stalled = quality.reversals >= STALL_REVERSALS;
    if (process.env.NODE_ENV !== "production") {
      console.info("[rep]", count.type, {
        rom: count.rom,
        faults: faults.map((f) => `${f.rule.id}:${f.status}@${Math.round(f.value)}`),
        framesInRep: this.repFrames,
        framesLost: this.repLostFrames,
        durationMs: Math.round(quality.durationMs),
        reversals: quality.reversals,
        smoothness: quality.smoothness,
        counted: count.type === "rep" && !faults.some((f) => f.status === "bad") && !lost && !badStart && !rushed && !stalled,
      });
    }
    this.resetRep();

    if (count.type !== "rep") return { ...count, faults, quality };
    if (faults.some((f) => f.status === "bad")) return { ...count, type: "partial", faults, quality };
    if (unseen) {
      return { ...count, type: "partial", faults, quality, noteId: "unseen", note: unseen.unseen_cue ?? "Step back so your whole body is in frame" };
    }
    if (lost) return { ...count, type: "partial", faults, quality, noteId: "lost", note: "Stay fully in frame for the whole rep" };
    if (badStart) return { ...count, type: "partial", faults, quality, noteId: "start", note: this.exercise.rep!.start_check!.cue };
    if (rushed) return { ...count, type: "partial", faults, quality, noteId: "rushed", note: "Slow down and control the movement" };
    if (stalled) return { ...count, type: "partial", faults, quality, noteId: "stalled", note: "Keep one smooth motion, don't stop or bounce midway" };
    this.counter!.commit();
    return { ...count, faults, quality };
  }

  /** Duration and direction changes of the finished rep, from the rep metric's trajectory. */
  private repQuality(): RepQuality {
    // Smooth progress so landmark jitter doesn't register as a change of direction.
    const track: { t: number; p: number }[] = [];
    for (const { t, p } of this.repTrack) track.push({ t, p: ema(track[track.length - 1]?.p, p, PROGRESS_SMOOTHING) });
    const durationMs = track.length > 1 ? track[track.length - 1].t - track[0].t : 0;
    // Count direction changes of at least REVERSAL_HYSTERESIS, not counting the natural turn at the peak (so a clean rep has 0).
    let rising = true; // every rep leaves the start position heading towards the peak
    let extreme = track[0]?.p ?? 0;
    let turns = 0;
    for (const { p } of track) {
      if (rising ? p > extreme : p < extreme) extreme = p;
      else if (Math.abs(p - extreme) >= REVERSAL_HYSTERESIS) {
        rising = !rising;
        extreme = p;
        turns += 1;
      }
    }
    const reversals = Math.max(0, turns - 1);
    const smoothness = Math.max(0, 100 - reversals * REVERSAL_PENALTY);
    return { durationMs, reversals, smoothness };
  }

  private resetRep() {
    this.repTrack = [];
    this.repAgg.clear();
    this.repLiveBad.clear();
    this.repFrames = 0;
    this.repLostFrames = 0;
  }

  private evaluateRep(): FaultHit[] {
    const hits: FaultHit[] = [];
    for (const rule of this.repRules) {
      const values: MetricValue[] = [];
      for (const [key, agg] of this.repAgg) {
        if (key.startsWith(`${rule.metric}:`)) values.push({ side: agg.side, value: rule.agg === "max" ? agg.max : agg.min });
      }
      const hit = evaluateRule(rule, values);
      if (hit) hits.push(hit);
    }
    this.repAgg.clear();
    return hits;
  }

  private onRep(event: RepEvent, now: number) {
    this.breakdown.rom = event.rom;
    this.repHits = event.faults;
    this.repHitsAt = now;
    this.lastRepQuality = Math.max(0, 100 - event.faults.reduce((s, h) => s + PENALTY[h.status], 0));
    const clean = event.type === "rep" && event.faults.length === 0 && this.liveLast.size === 0;
    this.cleanStreak = clean ? this.cleanStreak + 1 : 0;
  }

  /** Debounces live faults; returns those that have persisted long enough to act on. */
  private trackLive(hits: FaultHit[], now: number): FaultHit[] {
    for (const hit of hits) {
      this.liveLast.set(hit.rule.id, { hit, at: now });
      if (!this.liveSince.has(hit.rule.id)) this.liveSince.set(hit.rule.id, now);
    }
    for (const [id, last] of this.liveLast) {
      if (now - last.at > FAULT_CLEAR_MS) {
        this.liveLast.delete(id);
        this.liveSince.delete(id);
      }
    }
    return [...this.liveLast.entries()]
      .filter(([id]) => now - (this.liveSince.get(id) ?? now) >= FAULT_CONFIRM_MS)
      .map(([, last]) => last.hit);
  }

  private chooseIssue(live: FaultHit[], setupOk: boolean, inFrame: boolean, now: number): FormIssue | null {
    if (this.wrongView && inFrame) {
      return {
        id: "view",
        label: "Wrong angle",
        message: `${this.exercise.camera_setup}.`,
        status: "warn",
        side: null,
        fromRep: false,
      };
    }
    if (!this.framed) {
      return {
        id: "framed",
        label: "Can't see you",
        message:
          this.exercise.body_scope === "upper"
            ? "Keep your shoulders, elbows and hands in frame"
            : (this.exercise.faults.find((f) => f.unseen_cue)?.unseen_cue ?? "Step back so your whole body is in frame"),
        status: "warn",
        side: null,
        fromRep: false,
      };
    }
    const setup = this.exercise.setup;
    if (setup && !setupOk && inFrame) {
      this.setupFailSince ??= now;
      if (now - this.setupFailSince >= SETUP_CONFIRM_MS) {
        return { id: "setup", label: "Get into position", message: setup.cue, status: "warn", side: null, fromRep: false };
      }
      return null;
    }
    this.setupFailSince = null;

    const repHits = now - this.repHitsAt < REP_ISSUE_MS ? this.repHits : [];
    const order = (h: FaultHit) => this.exercise.faults.indexOf(h.rule);
    const candidates = [
      ...live.map((hit) => ({ hit, fromRep: false })),
      ...repHits.map((hit) => ({ hit, fromRep: true })),
    ].sort(
      (a, b) =>
        severityRank(b.hit.status) - severityRank(a.hit.status) ||
        Number(a.fromRep) - Number(b.fromRep) || // live problems first: they're happening right now
        order(a.hit) - order(b.hit),
    );
    const top = candidates[0];
    // Why the last rep wasn't counted (out of frame, too fast, not smooth) outranks its minor depth/range cues.
    if (this.seenProblem && now - this.seenProblem.at < REP_ISSUE_MS && (!top || (top.fromRep && top.hit.status === "warn"))) {
      const { id, message } = this.seenProblem;
      return { id, label: NOTE_LABEL[id], message, status: "warn", side: null, fromRep: true };
    }
    if (!top) return null;
    return {
      id: top.hit.rule.id,
      label: top.hit.rule.label,
      message: faultMessage(top.hit, this.exercise),
      status: top.hit.status,
      side: top.hit.sides.length === 1 ? top.hit.sides[0] : null,
      fromRep: top.fromRep,
    };
  }

  private jointStatus(sides: Side[], liveHits: FaultHit[], now: number): Map<number, JointStatus> {
    const status = new Map<number, JointStatus>();
    const mark = (indices: number[], s: JointStatus) => {
      for (const i of indices) {
        if (severityRank(s) >= severityRank(status.get(i) ?? "good")) status.set(i, s);
      }
    };
    for (const rule of this.exercise.faults) mark(metricLandmarks(rule.metric, sides), "good");
    if (this.exercise.rep) mark(metricLandmarks(this.exercise.rep.metric, sides), "good");
    const recentRep = now - this.repHitsAt < REP_HIGHLIGHT_MS ? this.repHits : [];
    for (const hit of [...liveHits, ...recentRep]) {
      mark(metricLandmarks(hit.rule.metric, hit.sides.length ? hit.sides : sides), hit.status);
    }
    return status;
  }

  private snapshot(
    s: Pick<EngineSnapshot, "landmarks" | "angles" | "inFrame" | "setupOk" | "jointStatus"> &
      Partial<Pick<EngineSnapshot, "repEvent" | "issue" | "coachIssue" | "praise">>,
  ): EngineSnapshot {
    return {
      repEvent: null,
      issue: null,
      coachIssue: null,
      praise: false,
      ...s,
      score: this.score,
      breakdown: { ...this.breakdown },
      averageScore: this.scoreFrames ? this.scoreSum / this.scoreFrames : null,
      reps: this.counter?.reps ?? 0,
      holdMs: this.holdMs,
      phase: this.counter?.phase ?? "start",
    };
  }
}
