import { useEffect, useRef, type MutableRefObject } from "react";
import type { JointAngles, JointName, JointStatus } from "@/types";
import type { Landmark } from "@/types/mediapipe";
import { JOINT_TRIPLETS, MIN_VISIBILITY } from "@/utils/poseValidation";

export interface SkeletonFrame {
  landmarks: Landmark[] | null;
  jointStatus: Map<number, JointStatus>;
  angles: JointAngles;
  updatedAt: number;
}

interface Props {
  frameRef: MutableRefObject<SkeletonFrame>;
  width: number;
  height: number;
  mirrored: boolean;
  showAngles: boolean;
}

const CONNECTIONS: [number, number][] = [
  [11, 12], [11, 23], [12, 24], [23, 24], // torso
  [11, 13], [13, 15], [12, 14], [14, 16], // arms
  [15, 17], [15, 19], [17, 19], [16, 18], [16, 20], [18, 20], // hands
  [23, 25], [25, 27], [24, 26], [26, 28], // legs
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32], // feet
];
const POINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];

// good → warn → bad, interpolated by a 0..2 "level" for smooth colour transitions.
// Soft palette tones, lifted slightly so they read clearly over live video.
const PALETTE: [number, number, number][] = [
  [196, 216, 228], // dusty blue
  [233, 196, 132], // sand-ochre
  [224, 122, 104], // terracotta
];
const LEVEL: Record<JointStatus, number> = { good: 0, warn: 1, bad: 2 };
const TRANSITION_MS = 200;
const DRAW_IN_MS = 500;
const STALE_MS = 500;

function levelColor(level: number, alpha = 1): string {
  const i = Math.min(1, Math.floor(level));
  const t = level - i;
  const [a, b] = [PALETTE[i], PALETTE[i + 1]];
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

/** Draws the pose on a canvas overlay in its own animation loop, decoupled from React renders. */
export default function PoseSkeleton({ frameRef, width, height, mirrored, showAngles }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const levels = new Map<number, number>();
    let raf = 0;
    let visibleSince: number | null = null;
    let lastT = performance.now();

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const dt = t - lastT;
      lastT = t;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const frame = frameRef.current;
      const lm = frame.landmarks;
      if (!lm || t - frame.updatedAt > STALE_MS) {
        visibleSince = null;
        levels.clear();
        return;
      }
      visibleSince ??= t;
      const reveal = Math.min(1, (t - visibleSince) / DRAW_IN_MS);

      // Ease each joint's colour level toward its current status.
      const step = Math.min(1, dt / TRANSITION_MS);
      for (const i of POINTS) {
        const target = LEVEL[frame.jointStatus.get(i) ?? "good"];
        const cur = levels.get(i) ?? target;
        levels.set(i, cur + (target - cur) * step);
      }

      const s = Math.max(w, h) / 1280;
      const visible = (i: number) => (lm[i]?.visibility ?? 0) >= MIN_VISIBILITY;
      const px = (i: number) => lm[i].x * w;
      const py = (i: number) => lm[i].y * h;

      // Bones — drawn in sequence when the person first appears.
      ctx.lineCap = "round";
      ctx.lineWidth = 6 * s;
      const bones = Math.ceil(reveal * CONNECTIONS.length);
      for (let k = 0; k < bones; k++) {
        const [a, b] = CONNECTIONS[k];
        if (!visible(a) || !visible(b)) continue;
        const color = levelColor(Math.max(levels.get(a) ?? 0, levels.get(b) ?? 0), 0.85);
        ctx.strokeStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12 * s;
        ctx.beginPath();
        ctx.moveTo(px(a), py(a));
        ctx.lineTo(px(b), py(b));
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      // Joints — tracked joints are larger; joints needing correction pulse.
      const pulse = 0.5 + 0.5 * Math.sin((t / 1000) * Math.PI * 4);
      for (const i of POINTS) {
        if (!visible(i)) continue;
        const level = levels.get(i) ?? 0;
        const tracked = frame.jointStatus.has(i);
        let r = (tracked ? 9 : 5) * s;
        if (level > 0.5) {
          r *= 1 + 0.35 * pulse;
          ctx.fillStyle = levelColor(level, 0.25 * (1 - pulse) + 0.1);
          ctx.beginPath();
          ctx.arc(px(i), py(i), r * 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = levelColor(level);
        ctx.strokeStyle = "rgba(251,250,248,0.95)";
        ctx.lineWidth = 2 * s;
        ctx.beginPath();
        ctx.arc(px(i), py(i), r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      if (showAngles) {
        ctx.font = `500 ${16 * s}px system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        for (const [joint, angle] of Object.entries(frame.angles) as [JointName, number][]) {
          const v = JOINT_TRIPLETS[joint][1];
          ctx.save();
          ctx.translate(px(v), py(v));
          if (mirrored) ctx.scale(-1, 1); // keep text readable in a mirrored view
          const label = `${Math.round(angle)}°`;
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(59,63,73,0.7)";
          ctx.fillRect(12 * s, -12 * s, tw + 10 * s, 24 * s);
          ctx.fillStyle = levelColor(levels.get(v) ?? 0);
          ctx.fillText(label, 17 * s, 0);
          ctx.restore();
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [frameRef, mirrored, showAngles]);

  return (
    <canvas
      ref={canvasRef}
      width={width || 1280}
      height={height || 720}
      className="pointer-events-none absolute inset-0 h-full w-full object-contain"
    />
  );
}
