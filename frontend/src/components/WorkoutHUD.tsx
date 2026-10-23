import { AnimatePresence, motion } from "framer-motion";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import type { Exercise } from "@/types";
import { formatDuration, formatPercent, STATUS_COLORS } from "@/utils/formatters";

interface Props {
  exercise: Exercise;
  cameraOn: boolean;
}

export default function WorkoutHUD({ exercise, cameraOn }: Props) {
  const reps = useWorkoutState((s) => s.reps);
  const holdMs = useWorkoutState((s) => s.holdMs);
  const averageScore = useWorkoutState((s) => s.averageScore);
  const score = useWorkoutState((s) => s.score);
  const issue = useWorkoutState((s) => s.issue);
  const coach = useWorkoutState((s) => s.coach);
  const activeMs = useWorkoutState((s) => s.activeMs);

  const isHold = exercise.mode === "hold";
  const displayScore = score ?? averageScore;
  const currentCue = coach.correction?.text || issue?.message;

  return (
    <div className="w-full space-y-3">
      {/* Telemetry Bar (Consolidated metrics pinned to the workout frame) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-slate/10 overflow-hidden rounded-2xl bg-paper border border-slate/10 shadow-xs">
        {/* Metric 1: Reps / Hold Time */}
        <div className="px-4 py-3 text-center">
          <p className="font-display text-2xl font-medium text-slate">
            {isHold ? `${Math.round(holdMs / 1000)}s` : `${reps}`}
            <span className="text-xs font-light text-stone ml-1">
              / {isHold ? `${exercise.hold_target_sec}s` : exercise.rep_target}
            </span>
          </p>
          <p className="eyebrow mt-0.5 !text-[10px]">{isHold ? "Hold Time" : "Reps Completed"}</p>
        </div>

        {/* Metric 2: Live Form Score */}
        <div className="px-4 py-3 text-center">
          <p className="font-display text-2xl font-medium text-slate">
            {formatPercent(displayScore)}
          </p>
          <p className="eyebrow mt-0.5 !text-[10px]">Form Alignment</p>
        </div>

        {/* Metric 3: Active Duration */}
        <div className="px-4 py-3 text-center hidden sm:block">
          <p className="font-display text-2xl font-medium text-slate">
            {formatDuration(activeMs / 1000)}
          </p>
          <p className="eyebrow mt-0.5 !text-[10px]">Active Time</p>
        </div>

        {/* Metric 4: Coach Status */}
        <div className="px-4 py-3 text-center flex flex-col items-center justify-center">
          <div className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${
                coach.connection === "online" ? "bg-good" : "bg-stone/40"
              }`}
            />
            <span className="font-display text-base text-slate font-medium">
              {coach.connection === "online" ? "AI Coach Active" : "Local Coach"}
            </span>
          </div>
          <p className="eyebrow mt-0.5 !text-[10px]">Guidance Engine</p>
        </div>
      </div>

      {/* Floating Active Guidance Banner (Only shown when a coaching cue is active) */}
      <AnimatePresence>
        {currentCue && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className="flex items-center gap-3 rounded-2xl bg-paper px-4 py-3 border border-slate/10 shadow-soft"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full animate-pulse"
              style={{ backgroundColor: issue ? STATUS_COLORS[issue.status] : "#2E7D32" }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-slate uppercase tracking-wider">
                {issue?.label || "AI Coach Feedback"}
              </p>
              <p className="text-sm font-medium text-slate mt-0.5 font-display italic">
                “{currentCue}”
              </p>
            </div>
            {issue?.side && (
              <span className="pill !px-2.5 !py-0.5 text-[10px] uppercase font-semibold text-stone border-slate/15">
                {issue.side} side
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
