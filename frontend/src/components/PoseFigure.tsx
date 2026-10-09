import { motion, useReducedMotion } from "framer-motion";
import { FIGURE_BONES, FIGURE_POSES, type FigurePoint } from "@/utils/figurePoses";

interface Props {
  exerciseId: string;
  color?: string;
  className?: string;
  /** Seconds per full rep. */
  duration?: number;
  delay?: number;
}

/** A minimal line figure looping through an exercise's movement. */
export default function PoseFigure({ exerciseId, color = "#4A4F5C", className, duration = 2.6, delay = 0 }: Props) {
  const reduce = useReducedMotion();
  const poses = FIGURE_POSES[exerciseId];
  if (!poses) return null;
  const [a, b] = poses;

  const transition = {
    duration,
    delay,
    repeat: Infinity,
    ease: "easeInOut",
    times: [0, 0.4, 0.6, 1], // ease in, hold at the peak, ease out
  } as const;
  const track = (p: FigurePoint, i: 0 | 1) => (reduce ? b[p][i] : [a[p][i], b[p][i], b[p][i], a[p][i]]);

  return (
    <svg viewBox="0 -8 100 124" className={className} aria-hidden>
      {/* floor */}
      <line x1="10" y1="109" x2="90" y2="109" stroke={color} strokeOpacity="0.25" strokeWidth="1" />
      <g stroke={color} strokeWidth="2.6" strokeLinecap="round" fill="none">
        {FIGURE_BONES.map(([p, q]) => (
          <motion.line
            key={`${p}-${q}`}
            initial={false}
            x1={a[p][0]}
            y1={a[p][1]}
            x2={a[q][0]}
            y2={a[q][1]}
            animate={{ x1: track(p, 0), y1: track(p, 1), x2: track(q, 0), y2: track(q, 1) }}
            transition={transition}
          />
        ))}
      </g>
      <motion.circle
        r="6.5"
        fill="none"
        stroke={color}
        strokeWidth="2.6"
        initial={false}
        cx={a.head[0]}
        cy={a.head[1]}
        animate={{ cx: track("head", 0), cy: track("head", 1) }}
        transition={transition}
      />
    </svg>
  );
}
