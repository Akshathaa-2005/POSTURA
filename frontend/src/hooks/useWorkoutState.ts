import { create } from "zustand";
import type { ModelRead } from "@/ml/formModel";
import type { AvatarCommand, DetectionStatus, FormIssue, JointStatus, RepEvent, RepPhase, ScoreBreakdown } from "@/types";
import type { EngineSnapshot } from "@/utils/workoutEngine";
import type { ConnectionState } from "@/utils/websocket";
import type { Landmark } from "@/types/mediapipe";

/** The user's pose captured when the current cue appeared, for the "You vs. Aim for" comparison. */
export interface IssueSnapshot {
  issueId: string;
  landmarks: Landmark[];
  /** Video width ÷ height, to draw the pose with true proportions. */
  aspect: number;
  jointStatus: [number, JointStatus][];
}

export interface CoachCorrection {
  id: number;
  faultId: string;
  label: string;
  status: JointStatus;
  text: string;
  source: "llm" | "template" | "cache";
  at: number;
  avatarCommand?: AvatarCommand | null;
}

export interface CoachVoice {
  id: number;
  /** Audio file from the server, or "" when the browser should speak `text` itself. */
  url: string;
  text: string;
}

export interface CoachState {
  connection: ConnectionState;
  sessionId: string | null;
  llm: boolean;
  tts: boolean;
  correction: CoachCorrection | null;
  voice: CoachVoice | null;
  avatarCommand: AvatarCommand | null;
}

interface WorkoutState {
  exerciseId: string | null;
  repTarget: number;
  status: DetectionStatus;
  error: string | null;

  personVisible: boolean;
  inFrame: boolean;
  score: number | null;
  breakdown: ScoreBreakdown;
  averageScore: number | null;
  reps: number;
  holdMs: number;
  partialReps: number;
  phase: RepPhase;
  issue: FormIssue | null;
  issueSnapshot: IssueSnapshot | null;
  lastEvent: RepEvent | null;
  /** The form model's read of the last rep, when a model is installed. */
  modelRead: (ModelRead & { at: number; repType: RepEvent["type"] }) | null;
  fps: number;
  /** Time spent actively tracking (excludes pauses). */
  activeMs: number;
  coach: CoachState;

  reset: (exerciseId: string, repTarget: number) => void;
  setStatus: (status: DetectionStatus, error?: string | null) => void;
  setModelRead: (read: WorkoutState["modelRead"]) => void;
  applySnapshot: (
    s: EngineSnapshot,
    extra: { fps: number; dtMs: number; event: RepEvent | null; aspect: number },
  ) => void;
  setCoach: (patch: Partial<CoachState>) => void;
}

const initialCoach: CoachState = {
  connection: "offline",
  sessionId: null,
  llm: false,
  tts: false,
  correction: null,
  voice: null,
  avatarCommand: null,
};

const initialMetrics = {
  personVisible: false,
  inFrame: false,
  score: null,
  breakdown: { upper: null, core: null, lower: null, rom: null },
  averageScore: null,
  reps: 0,
  holdMs: 0,
  partialReps: 0,
  phase: "start" as RepPhase,
  issue: null,
  issueSnapshot: null,
  lastEvent: null,
  modelRead: null,
  fps: 0,
  activeMs: 0,
};

export const useWorkoutState = create<WorkoutState>((set) => ({
  exerciseId: null,
  repTarget: 0,
  status: "idle",
  error: null,
  ...initialMetrics,
  coach: initialCoach,

  // Keeps the live connection, but clears the previous session's coaching.
  reset: (exerciseId, repTarget) =>
    set((state) => ({
      exerciseId,
      repTarget,
      ...initialMetrics,
      coach: { ...state.coach, sessionId: null, correction: null, voice: null, avatarCommand: null },
    })),

  setCoach: (patch) => set((state) => ({ coach: { ...state.coach, ...patch } })),

  setStatus: (status, error = null) => set({ status, error }),

  setModelRead: (modelRead) => set({ modelRead }),

  applySnapshot: (s, { fps, dtMs, event, aspect }) =>
    set((state) => ({
      personVisible: s.landmarks !== null,
      inFrame: s.inFrame,
      score: s.score,
      breakdown: s.breakdown,
      averageScore: s.averageScore,
      reps: s.reps,
      holdMs: s.holdMs,
      phase: s.phase,
      issue: s.issue,
      // Freeze the pose the moment a new cue appears; keep it while that cue stays up.
      issueSnapshot: !s.issue
        ? null
        : state.issueSnapshot?.issueId === s.issue.id
          ? state.issueSnapshot
          : s.landmarks
            ? { issueId: s.issue.id, landmarks: s.landmarks, aspect, jointStatus: [...s.jointStatus] }
            : null,
      partialReps: state.partialReps + (event?.type === "partial" ? 1 : 0),
      lastEvent: event ?? state.lastEvent,
      fps,
      activeMs: state.activeMs + dtMs,
    })),
}));
