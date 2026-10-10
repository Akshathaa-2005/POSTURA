import type { JointStatus } from "@/types";
import type { Landmark } from "@/types/mediapipe";
import { STATUS_COLORS } from "@/utils/formatters";
import { MIN_VISIBILITY } from "@/utils/poseValidation";
import { CONNECTIONS } from "./PoseSkeleton";

interface Props {
  landmarks: Landmark[];
  jointStatus: [number, JointStatus][];
  aspect: number;
  mirrored: boolean;
  className?: string;
}

const VIEW_W = 100;
const VIEW_H = 120;
const NEUTRAL = "#4A4F5C";

/** A still line drawing of the user's own pose, cropped to the body, with faulty joints coloured. */
export default function PoseSnapshot({ landmarks, jointStatus, aspect, mirrored, className }: Props) {
  const status = new Map(jointStatus);
  const visible = (i: number) => (landmarks[i]?.visibility ?? 0) >= MIN_VISIBILITY;
  const idx = landmarks.map((_, i) => i).filter((i) => i === 0 || i >= 11).filter(visible);
  if (idx.length < 4) return null;

  // Fit the visible body into the view box, preserving proportions.
  const raw = (i: number) => ({ x: (mirrored ? 1 - landmarks[i].x : landmarks[i].x) * aspect, y: landmarks[i].y });
  const xs = idx.map((i) => raw(i).x);
  const ys = idx.map((i) => raw(i).y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = Math.min((VIEW_W * 0.84) / Math.max(maxX - minX, 1e-3), (VIEW_H * 0.84) / Math.max(maxY - minY, 1e-3));
  const offX = (VIEW_W - (maxX - minX) * scale) / 2;
  const offY = (VIEW_H - (maxY - minY) * scale) / 2;
  const pt = (i: number) => ({ x: offX + (raw(i).x - minX) * scale, y: offY + (raw(i).y - minY) * scale });

  const rank = (i: number) => ({ bad: 2, warn: 1, good: 0 })[status.get(i) ?? "good"];
  const color = (i: number) => {
    const s = status.get(i);
    return s && s !== "good" ? STATUS_COLORS[s] : NEUTRAL;
  };
  /** A bone takes the colour of its more serious end. */
  const worst = (a: number, b: number) => color(rank(a) >= rank(b) ? a : b);

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className={className} role="img" aria-label="Your pose when the issue was detected">
      {CONNECTIONS.filter(([a, b]) => visible(a) && visible(b)).map(([a, b]) => {
        const p = pt(a);
        const q = pt(b);
        return <line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={worst(a, b)} strokeWidth={2.4} strokeLinecap="round" />;
      })}
      {visible(0) && <circle cx={pt(0).x} cy={pt(0).y} r={5.5} fill="none" stroke={NEUTRAL} strokeWidth={2.4} />}
      {idx
        .filter((i) => status.get(i) && status.get(i) !== "good")
        .map((i) => (
          <circle key={i} cx={pt(i).x} cy={pt(i).y} r={4} fill={color(i)} stroke="#FBFAF8" strokeWidth={1.5} />
        ))}
    </svg>
  );
}
