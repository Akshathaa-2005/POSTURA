import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import type { Exercise } from "@/types";
import { getAvatarCommandForFault } from "@/utils/avatarCorrections";
import { STATUS_COLORS, STATUS_LABEL } from "@/utils/formatters";
import AvatarCoach3D from "./AvatarCoach3D";
import { PoseGuideTarget } from "./PoseGuide";
import PoseSnapshot from "./PoseSnapshot";

export default function CurrentIssueCard({ exercise, mirrored }: { exercise: Exercise; mirrored: boolean }) {
  const issue = useWorkoutState((s) => s.issue);
  const snapshot = useWorkoutState((s) => s.issueSnapshot);
  const coachAvatarCmd = useWorkoutState((s) => s.coach.avatarCommand);
  const tracking = useWorkoutState((s) => s.status === "running" && s.inFrame);
  const [viewMode, setViewMode] = useState<"3d" | "2d">("3d");

  // Prefer backend LLM command, fall back to client-side canonical biomechanical command
  const avatarCmd =
    coachAvatarCmd && coachAvatarCmd.primary_fault === issue?.id
      ? coachAvatarCmd
      : issue
        ? getAvatarCommandForFault(issue.id, issue.side)
        : null;

  return (
    <section className="card relative min-h-[140px] overflow-hidden p-6">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow">Guidance</h2>
        {issue && avatarCmd && (
          <div className="flex rounded-full bg-slate/10 p-0.5 text-[11px]">
            <button
              onClick={() => setViewMode("3d")}
              className={`rounded-full px-2.5 py-0.5 font-medium transition ${
                viewMode === "3d" ? "bg-slate text-linen shadow-sm" : "text-stone hover:text-ink"
              }`}
            >
              3D Avatar
            </button>
            <button
              onClick={() => setViewMode("2d")}
              className={`rounded-full px-2.5 py-0.5 font-medium transition ${
                viewMode === "2d" ? "bg-slate text-linen shadow-sm" : "text-stone hover:text-ink"
              }`}
            >
              Comparison
            </button>
          </div>
        )}
      </div>

      <AnimatePresence mode="wait">
        {issue ? (
          <motion.div
            key={issue.id}
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="mt-4 flex flex-col gap-3"
          >
            <div className="flex gap-4">
              <span className="w-0.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_COLORS[issue.status] }} />
              <div>
                <p className="eyebrow !tracking-[0.18em]" style={{ color: STATUS_COLORS[issue.status] }}>
                  {issue.label}
                  <span className="text-stone">
                    {" "}
                    · {issue.id === "setup" ? "Setup" : issue.fromRep ? "Last rep" : STATUS_LABEL[issue.status]}
                  </span>
                </p>
                <p className="mt-1 font-display text-2xl leading-snug text-slate">{issue.message}</p>
              </div>
            </div>

            {/* Visual Guidance: 3D Avatar Demo or 2D Snapshot */}
            {viewMode === "3d" && avatarCmd ? (
              <div className="mt-2 overflow-hidden rounded-2xl">
                <AvatarCoach3D
                  command={avatarCmd}
                  exerciseId={exercise.id}
                  defaultView={exercise.view === "side" ? "side" : "perspective"}
                  className="h-56 w-full"
                />
              </div>
            ) : snapshot?.issueId === issue.id ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <figure className="rounded-[14px] bg-paper p-2">
                  <PoseSnapshot {...snapshot} mirrored={mirrored} className="mx-auto h-28 w-full" />
                  <figcaption className="eyebrow mt-1 text-center !text-[10px]">You</figcaption>
                </figure>
                <figure className="rounded-[14px] bg-mist/70 p-2">
                  <PoseGuideTarget exerciseId={exercise.id} className="mx-auto h-28 w-full" />
                  <figcaption className="eyebrow mt-1 text-center !text-[10px]">Aim for</figcaption>
                </figure>
              </div>
            ) : null}
          </motion.div>
        ) : (
          <motion.div
            key="ok"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            className="mt-4"
          >
            {tracking ? (
              <p className="font-display text-2xl italic text-good">Beautiful alignment. Keep flowing.</p>
            ) : (
              <p className="text-sm font-light leading-relaxed text-stone">{exercise.description}</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
