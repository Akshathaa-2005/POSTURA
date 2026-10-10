import { AnimatePresence, motion } from "framer-motion";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import type { Exercise } from "@/types";
import { STATUS_COLORS, STATUS_LABEL } from "@/utils/formatters";

export default function CurrentIssueCard({ exercise }: { exercise: Exercise }) {
  const issue = useWorkoutState((s) => s.issue);
  const tracking = useWorkoutState((s) => s.status === "running" && s.inFrame);

  return (
    <section className="card relative min-h-[140px] overflow-hidden p-6">
      <h2 className="eyebrow">Guidance</h2>
      <AnimatePresence mode="wait">
        {issue ? (
          <motion.div
            key={issue.id}
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="mt-4 flex gap-4"
          >
            <span className="w-0.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_COLORS[issue.status] }} />
            <div>
              <p className="eyebrow !tracking-[0.18em]" style={{ color: STATUS_COLORS[issue.status] }}>
                {issue.label}
                <span className="text-stone"> · {issue.id === "setup" ? "Setup" : issue.fromRep ? "Last rep" : STATUS_LABEL[issue.status]}</span>
              </p>
              <p className="mt-2 font-display text-2xl leading-snug text-slate">{issue.message}</p>
            </div>
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
