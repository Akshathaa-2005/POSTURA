import { create } from "zustand";
import type { DetectionStatus, FormIssue, JointStatus, RepEvent, RepPhase, ScoreBreakdown } from "@/types";
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
}

export interface CoachVoice {
  id: number;
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
  fps: number;
  /** Time spent actively tracking (excludes pauses). */
  activeMs: number;
  coach: CoachState;

  reset: (exerciseId: string, repTarget: number) => void;
  setStatus: (status: DetectionStatus, error?: string | null) => void;
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
      coach: { ...state.coach, sessionId: null, correction: null, voice: null },
    })),

  setCoach: (patch) => set((state) => ({ coach: { ...state.coach, ...patch } })),

  setStatus: (status, error = null) => set({ status, error }),

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
