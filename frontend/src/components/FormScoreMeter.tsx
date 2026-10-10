import { useEffect } from "react";
import { motion, useSpring, useTransform } from "framer-motion";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import { formatPercent, scoreStatus, STATUS_COLORS, STATUS_LABEL } from "@/utils/formatters";

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function FormScoreMeter() {
  const score = useWorkoutState((s) => s.score);
  const breakdown = useWorkoutState((s) => s.breakdown);
  const status = scoreStatus(score);
  const color = STATUS_COLORS[status];

  // Smooth ~1s counter animation as the score changes.
  const spring = useSpring(0, { stiffness: 60, damping: 18 });
  const display = useTransform(spring, (v) => Math.round(v).toString());
  const dashOffset = useTransform(spring, (v) => CIRCUMFERENCE * (1 - v / 100));
  useEffect(() => spring.set(score ?? 0), [score, spring]);

  const parts = [
    { label: "Upper body", value: breakdown.upper },
    { label: "Core", value: breakdown.core },
    { label: "Lower body", value: breakdown.lower },
    { label: "Range", value: breakdown.rom },
  ];

  return (
    <section className="card p-6">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow">Form score</h2>
        {score !== null && (
          <span className="eyebrow !tracking-[0.18em]" style={{ color }}>
            {STATUS_LABEL[status]}
          </span>
        )}
      </div>
      <div className="mt-4 flex items-center gap-6">
        <div className="relative h-32 w-32 shrink-0">
          <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
            <circle cx="60" cy="60" r={RADIUS} fill="none" stroke="#E0E4E8" strokeWidth="6" />
            <motion.circle
              cx="60"
              cy="60"
              r={RADIUS}
              fill="none"
              stroke={color}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              style={{ strokeDashoffset: dashOffset, transition: "stroke 300ms" }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {score === null ? (
              <span className="font-display text-4xl text-stone/60">—</span>
            ) : (
              <motion.span className="font-display text-5xl font-medium leading-none" style={{ color }}>
                {display}
              </motion.span>
            )}
            <span className="eyebrow mt-1 !text-[10px]">of 100</span>
          </div>
        </div>

        <ul className="flex-1 space-y-3">
          {parts.map(({ label, value }) => (
            <li key={label}>
              <div className="flex justify-between text-xs">
                <span className="text-stone">{label}</span>
                <span className="tabular-nums text-ink">{formatPercent(value)}</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-mist">
                <motion.div
                  className="h-full rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${value ?? 0}%`, backgroundColor: STATUS_COLORS[scoreStatus(value)] }}
                  transition={{ duration: 0.5 }}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
