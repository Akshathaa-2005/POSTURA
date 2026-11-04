import type { Exercise, MetricName } from "@/types";

/** Body parts the camera has to see for an exercise's rules to be judged. */
export type BodyPart = "head" | "shoulders" | "elbows" | "wrists" | "hips" | "knees" | "ankles";

export const PART_ORDER: BodyPart[] = ["head", "shoulders", "elbows", "wrists", "hips", "knees", "ankles"];

export const PART_LABEL: Record<BodyPart, string> = {
  head: "Head",
  shoulders: "Shoulders",
  elbows: "Elbows",
  wrists: "Wrists",
  hips: "Hips",
  knees: "Knees",
  ankles: "Ankles",
};

// MediaPipe indices; a part counts as visible when either side (or the nose) is seen.
const LANDMARKS: Record<BodyPart, number[]> = {
  head: [0],
  shoulders: [11, 12],
  elbows: [13, 14],
  wrists: [15, 16],
  hips: [23, 24],
  knees: [25, 26],
  ankles: [27, 28],
};

const VISIBLE = 0.5;

/** Which parts each metric reads from. Anything not listed falls back to shoulders and hips. */
const NEEDS: Record<string, BodyPart[]> = {
  shoulder: ["shoulders", "elbows", "hips"],
  elbow: ["shoulders", "elbows", "wrists"],
  hip: ["shoulders", "hips", "knees"],
  knee: ["hips", "knees", "ankles"],
  knee_min: ["hips", "knees", "ankles"],
  knee_max: ["hips", "knees", "ankles"],
  knee_track: ["knees", "ankles"],
  knee_lift_max: ["hips", "knees"],
  hands_overhead: ["head", "shoulders", "wrists"],
  torso_lean: ["shoulders", "hips"],
  hip_sag: ["shoulders", "hips", "ankles"],
  stance_width: ["shoulders", "ankles"],
};

const FALLBACK: BodyPart[] = ["shoulders", "hips"];

function partsFor(metric: MetricName | undefined): BodyPart[] {
  return metric ? NEEDS[metric] ?? FALLBACK : [];
}

/** The body parts this exercise's setup, reps and faults depend on, in display order. */
export function requiredParts(exercise: Exercise): BodyPart[] {
  const metrics = [exercise.setup?.metric, exercise.rep?.metric, ...exercise.faults.map((f) => f.metric)];
  const used = new Set(metrics.flatMap((m) => partsFor(m)));
  if (used.size === 0) FALLBACK.forEach((p) => used.add(p));
  return PART_ORDER.filter((p) => used.has(p));
}

/** Per-part visibility from MediaPipe landmarks (index → visibility, 0-1). */
export function partVisible(visibility: number[], part: BodyPart): boolean {
  return LANDMARKS[part].some((i) => (visibility[i] ?? 0) >= VISIBLE);
}

export function missingParts(visibility: number[], parts: BodyPart[]): BodyPart[] {
  return parts.filter((p) => !partVisible(visibility, p));
}
