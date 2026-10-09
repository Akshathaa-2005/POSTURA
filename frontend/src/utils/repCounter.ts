import type { RepConfig, RepEvent, RepPhase } from "@/types";

/** A movement must travel at least this fraction of the way to the peak to count as a (partial) attempt. */
const PARTIAL_THRESHOLD = 0.5;
/** Leave the peak phase once progress drops below this (hysteresis against jitter). */
const PEAK_EXIT = 0.9;

/**
 * Counts reps with a start → moving → peak → start state machine.
 * Progress is normalised so 0 = start threshold and 1 = peak threshold,
 * which makes "increase" and "decrease" exercises behave identically.
 */
export class RepCounter {
  reps = 0;
  phase: RepPhase = "start";
  private armed = false; // must be seen in the start position before counting
  private maxProgress = 0;
  private reachedPeak = false;

  constructor(private readonly config: RepConfig) {}

  progress(angle: number): number {
    const { start_threshold: start, peak_threshold: peak } = this.config;
    return (angle - start) / (peak - start);
  }

  update(angle: number, now: number): RepEvent | null {
    const p = this.progress(angle);

    if (p <= 0) {
      const wasMoving = this.phase !== "start";
      const reachedPeak = this.reachedPeak;
      const rom = Math.round(Math.min(1, this.maxProgress) * 100);
      this.phase = "start";
      this.maxProgress = 0;
      this.reachedPeak = false;

      if (!this.armed) {
        this.armed = true;
        return null;
      }
      if (reachedPeak) {
        this.reps += 1;
        return { type: "rep", rom: 100, at: now };
      }
      if (wasMoving && rom >= PARTIAL_THRESHOLD * 100) {
        return { type: "partial", rom, at: now };
      }
      return null;
    }

    if (!this.armed) return null;
    this.maxProgress = Math.max(this.maxProgress, p);
    if (p >= 1) {
      this.phase = "peak";
      this.reachedPeak = true;
    } else if (this.phase === "start" || (this.phase === "peak" && p < PEAK_EXIT)) {
      this.phase = "moving";
    }
    return null;
  }

  reset() {
    this.reps = 0;
    this.phase = "start";
    this.armed = false;
    this.maxProgress = 0;
    this.reachedPeak = false;
  }
}
