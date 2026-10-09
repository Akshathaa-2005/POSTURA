import raw from "@exercises/exercises.json";
import type { Exercise } from "@/types";

const data = raw as unknown as Record<string, Omit<Exercise, "id">>;

export const EXERCISES: Exercise[] = Object.entries(data).map(([id, e]) => ({ id, ...e }));

export function getExercise(id: string): Exercise | undefined {
  return EXERCISES.find((e) => e.id === id);
}
