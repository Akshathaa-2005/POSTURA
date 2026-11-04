import type { RepConfig } from "@/types";

/**
 * Rep-validity constraints that sit on top of the angle rules in exercises/exercises.json.
 *
 * Angle thresholds (`start_threshold`, `peak_threshold`) and `faults[]` already decide range of motion and form.
 * What they can't see is *tempo*: a bounced rep (momentum, not muscle) or a stalled one passes every angle check.
 * Declare limits on the exercise's `rep` block:
 *
 *   "rep": { ..., "min_duration_ms": 700, "max_duration_ms": 8000 }
 *
 * Both are optional; an exercise without them behaves exactly as before.
 */

export type TempoVerdict = { ok: true } | { ok: false; reason: "too_fast" | "too_slow"; note: string };

const NOTES = {
  too_fast: "Slow down — control the movement instead of bouncing through it",
  too_slow: "Keep a steady pace — that rep stalled partway",
} as const;

/** Checks one completed rep's duration. A missing duration is never held against the rep. */
export function checkTempo(config: RepConfig, durationMs: number | undefined): TempoVerdict {
  if (durationMs === undefined) return { ok: true };
  if (config.min_duration_ms !== undefined && durationMs < config.min_duration_ms) {
    return { ok: false, reason: "too_fast", note: NOTES.too_fast };
  }
  if (config.max_duration_ms !== undefined && durationMs > config.max_duration_ms) {
    return { ok: false, reason: "too_slow", note: NOTES.too_slow };
  }
  return { ok: true };
}

/** Problems with a rep config's tempo limits (empty = fine). Used by the catalog test to catch JSON typos. */
export function tempoConfigProblems(config: RepConfig): string[] {
  const { min_duration_ms: min, max_duration_ms: max } = config;
  const problems: string[] = [];
  if (min !== undefined && !(min > 0)) problems.push("min_duration_ms must be > 0");
  if (max !== undefined && !(max > 0)) problems.push("max_duration_ms must be > 0");
  if (min !== undefined && max !== undefined && min >= max) problems.push("min_duration_ms must be below max_duration_ms");
  return problems;
}
