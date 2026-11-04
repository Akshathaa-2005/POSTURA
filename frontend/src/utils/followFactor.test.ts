import { describe, expect, it } from "vitest";
import { followFactor, MIMIC_TAU_MS } from "./avatarRig";

describe("followFactor", () => {
  it("covers the same fraction of the gap per second at any frame rate", () => {
    const remaining = (fps: number) => Math.pow(1 - followFactor(1000 / fps, MIMIC_TAU_MS), fps * 0.2);
    expect(remaining(30)).toBeCloseTo(remaining(144), 3);
    expect(remaining(60)).toBeCloseTo(Math.exp(-200 / MIMIC_TAU_MS), 3);
  });

  it("stays in (0, 1) and doesn't snap after a stalled frame", () => {
    expect(followFactor(0, MIMIC_TAU_MS)).toBeGreaterThan(0);
    expect(followFactor(60_000, MIMIC_TAU_MS)).toBe(followFactor(100, MIMIC_TAU_MS));
    expect(followFactor(100, MIMIC_TAU_MS)).toBeLessThan(1);
  });
});
