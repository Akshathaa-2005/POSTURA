import { AnimatePresence, motion } from "framer-motion";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import type { RepPhase } from "@/types";

const PHASE_LABEL: Record<RepPhase, string> = {
  start: "Ready",
  moving: "Moving",
  peak: "Hold",
};

export default function RepCounter() {
  const reps = useWorkoutState((s) => s.reps);
  const target = useWorkoutState((s) => s.repTarget);
  const phase = useWorkoutState((s) => s.phase);
  const done = target > 0 && reps >= target;

  return (
    <section className={`card p-6 transition-colors duration-500 ${done ? "!bg-[#EEF2EC]" : ""}`}>
      <div className="flex items-center justify-between">
        <h2 className="eyebrow">Repetitions</h2>
        <span
          className={`rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] transition ${
            phase === "peak" ? "bg-slate text-linen" : "bg-mist text-stone"
          }`}
        >
          {PHASE_LABEL[phase]}
        </span>
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={reps}
            initial={{ y: 18, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -18, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className={`font-display text-7xl font-medium leading-none ${done ? "text-done" : "text-slate"}`}
          >
            {reps}
          </motion.span>
        </AnimatePresence>
        <span className="font-display text-3xl text-stone/70">/ {target}</span>
      </div>

      {/* One bead per target rep */}
      <div className="mt-5 flex flex-wrap gap-1.5">
        {Array.from({ length: target }, (_, i) => (
          <motion.span
            key={i}
            className="h-1.5 flex-1 rounded-full"
            style={{ minWidth: 8 }}
            animate={{ backgroundColor: i < reps ? (done ? "#6F927A" : "#4A4F5C") : "#E0E4E8" }}
            transition={{ duration: 0.4 }}
          />
        ))}
      </div>

      <AnimatePresence>
        {done && (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className="mt-4 font-display text-xl italic text-done"
          >
            Set complete, beautifully done.
          </motion.p>
        )}
      </AnimatePresence>
    </section>
  );
}
