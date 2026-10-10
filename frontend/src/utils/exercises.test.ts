import { describe, expect, it } from "vitest";
import type { MetricName } from "@/types";
import { EXERCISES } from "./exercises";
import { FIGURE_POSES } from "./figurePoses";
import { METRIC_REGION } from "./poseValidation";
import { WorkoutEngine } from "./workoutEngine";

const METRICS = Object.keys(METRIC_REGION) as MetricName[];
const more = (op: "<" | ">", a: number, b: number) => (op === ">" ? a > b : a < b);

describe("exercise catalog", () => {
  it("has 20+ exercises", () => {
    expect(EXERCISES.length).toBeGreaterThanOrEqual(20);
  });

  describe.each(EXERCISES.map((e) => [e.id, e] as const))("%s", (_, ex) => {
    it("is well-formed", () => {
      expect(["front", "side"]).toContain(ex.view);
      expect(ex.correction_tips.length).toBeGreaterThan(0);
      expect(ex.voice_encouragement.length).toBeGreaterThan(0);
      expect(ex.faults.length).toBeGreaterThan(0);
      expect(FIGURE_POSES[ex.id], "needs an animated figure").toBeDefined();
      expect(() => new WorkoutEngine(ex)).not.toThrow();
      if (ex.mode === "hold") {
        expect(ex.setup, "holds are timed while the setup position holds").toBeDefined();
        expect(ex.hold_target_sec).toBeGreaterThan(0);
      } else {
        expect(ex.rep).toBeDefined();
        expect(ex.rep_target).toBeGreaterThan(0);
      }
    });

    it("has consistent rep thresholds", () => {
      if (!ex.rep) return;
      const { direction, start_threshold: start, peak_threshold: peak } = ex.rep;
      expect(METRICS).toContain(ex.rep.metric);
      expect(direction === "decrease" ? peak < start : peak > start).toBe(true);
    });

    it.each(ex.faults.map((f) => [f.id, f] as const))("fault %s is consistent", (_, f) => {
      expect(METRICS).toContain(f.metric);
      expect(f.cue.trim()).not.toBe("");
      if (f.bad !== undefined) expect(more(f.op, f.bad, f.warn), "bad must be beyond warn").toBe(true);
      if (f.when === "rep") {
        expect(ex.rep, "rep faults need a rep exercise").toBeDefined();
        expect(f.agg).toBeDefined();
      }
      if (f.cue_side) expect(f.cue_side).toContain("{side}");
      // A rep fault on the rep's own metric must be reachable: its warn line can't sit behind the start line.
      if (f.when === "rep" && ex.rep && f.metric === ex.rep.metric) {
        const { direction, start_threshold: start } = ex.rep;
        expect(direction === "decrease" ? f.warn < start : f.warn > start).toBe(true);
        // Counted reps sit between the count line and ideal form (minor cue); short of the line isn't counted,
        // so "warn" must be beyond the count line and "bad" behind it (it explains why a rep didn't count).
        const peak = ex.rep.peak_threshold;
        expect(more(f.op, peak, f.warn), `${f.id}: a rep just over the count line should get a minor cue`).toBe(true);
        if (f.bad !== undefined) expect(more(f.op, f.bad, peak), `${f.id}: bad should be short of the count line`).toBe(true);
      }
    });

    it("has unique fault ids", () => {
      const ids = ex.faults.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain("setup");
    });
  });
});

describe("figure_poses.json", () => {
  it("matches figurePoses.ts (run `npm run export:figures` after editing figures)", async () => {
    const exported = (await import("@exercises/figure_poses.json")).default;
    expect(exported).toEqual(JSON.parse(JSON.stringify(FIGURE_POSES)));
  });
});
