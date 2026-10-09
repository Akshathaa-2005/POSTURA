import { create } from "zustand";
import type { DetectionStatus, FormIssue, RepEvent, RepPhase, ScoreBreakdown } from "@/types";
import type { EngineSnapshot } from "@/utils/workoutEngine";

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
  phase: RepPhase;
  issue: FormIssue | null;
  lastEvent: RepEvent | null;
  fps: number;
  /** Time spent actively tracking (excludes pauses). */
  activeMs: number;

  reset: (exerciseId: string, repTarget: number) => void;
  setStatus: (status: DetectionStatus, error?: string | null) => void;
  applySnapshot: (s: EngineSnapshot, extra: { fps: number; dtMs: number; event: RepEvent | null }) => void;
}

const initialMetrics = {
  personVisible: false,
  inFrame: false,
  score: null,
  breakdown: { upper: null, core: null, lower: null, rom: null },
  averageScore: null,
  reps: 0,
  phase: "start" as RepPhase,
  issue: null,
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

  reset: (exerciseId, repTarget) => set({ exerciseId, repTarget, ...initialMetrics }),

  setStatus: (status, error = null) => set({ status, error }),

  applySnapshot: (s, { fps, dtMs, event }) =>
    set((state) => ({
      personVisible: s.landmarks !== null,
      inFrame: s.inFrame,
      score: s.score,
      breakdown: s.breakdown,
      averageScore: s.averageScore,
      reps: s.reps,
      phase: s.phase,
      issue: s.issue,
      lastEvent: event ?? state.lastEvent,
      fps,
      activeMs: state.activeMs + dtMs,
    })),
}));
