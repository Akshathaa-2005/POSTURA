import { describe, expect, it } from "vitest";
import { LM, type Landmark } from "@/types/mediapipe";
import { compareSources, percentile, type CompareFrame } from "./poseCompare";

const W = 1000;
const H = 1000;

/** A standing figure with a 0.3-tall torso; `dx` shifts the whole body, `knee` bends the left knee. */
function body(dx = 0, kneeX = 0.5): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const set = (i: number, x: number, y: number, visibility = 1) => (lm[i] = { x: x + dx, y, z: 0, visibility });
  set(LM.LEFT_SHOULDER, 0.55, 0.2);
  set(LM.RIGHT_SHOULDER, 0.45, 0.2);
  set(LM.LEFT_HIP, 0.54, 0.5);
  set(LM.RIGHT_HIP, 0.46, 0.5);
  set(LM.LEFT_KNEE, kneeX, 0.7);
  set(LM.LEFT_ANKLE, 0.54, 0.9);
  return lm;
}

const frame = (i: number, a: Landmark[] | null, b: Landmark[] | null, aMs = 5, bMs = 10): CompareFrame => ({
  t: i / 30,
  width: W,
  height: H,
  a,
  b,
  aMs,
  bMs,
});

const joint = (r: ReturnType<typeof compareSources>, name: string) => r.joints.find((j) => j.name === name)!;

describe("compareSources", () => {
  it("reports zero disagreement for identical sources", () => {
    const frames = Array.from({ length: 10 }, (_, i) => frame(i, body(), body()));
    const r = compareSources(frames);
    expect(r.torsoPx).toBeCloseTo(300);
    expect(joint(r, "left_knee").disagreementMean).toBe(0);
    expect(r.angles.find((a) => a.name === "left_knee")!.meanAbsDiffDeg).toBeCloseTo(0);
  });

  it("measures disagreement as a fraction of torso length", () => {
    const frames = Array.from({ length: 10 }, (_, i) => frame(i, body(), body(0.03)));
    expect(joint(compareSources(frames), "left_hip").disagreementMean).toBeCloseTo(0.1); // 30 px / 300 px
  });

  it("counts dropouts and frames with no pose per source", () => {
    const frames = [frame(0, body(), body()), frame(1, body(), null), frame(2, null, body()), frame(3, body(), body())];
    const r = compareSources(frames);
    expect(r.noPoseA).toBe(1);
    expect(r.noPoseB).toBe(1);
    expect(joint(r, "left_knee").dropoutA).toBeCloseTo(0.25);
    expect(joint(r, "left_knee").dropoutB).toBeCloseTo(0.25);
  });

  it("treats joints below the visibility gate as missing, with per-source gates", () => {
    const weak = body();
    weak[LM.LEFT_KNEE].visibility = 0.4;
    const frames = Array.from({ length: 4 }, (_, i) => frame(i, weak, weak));
    expect(joint(compareSources(frames), "left_knee").dropoutA).toBe(1);
    const r = compareSources(frames, { minVisibilityB: 0.3 });
    expect(joint(r, "left_knee").dropoutA).toBe(1);
    expect(joint(r, "left_knee").dropoutB).toBe(0);
  });

  it("scores steady motion as no jitter and zig-zag as jitter", () => {
    const smooth = Array.from({ length: 12 }, (_, i) => frame(i, body(i * 0.005), body(i * 0.005 + (i % 2) * 0.01)));
    const j = joint(compareSources(smooth), "left_knee");
    expect(j.jitterA).toBeCloseTo(0, 6);
    expect(j.jitterB!).toBeGreaterThan(0.05);
  });

  it("reports latency percentiles", () => {
    const frames = Array.from({ length: 100 }, (_, i) => frame(i, body(), body(), 4, i + 1));
    const r = compareSources(frames);
    expect(r.latency.a).toEqual({ p50: 4, p95: 4 });
    expect(r.latency.b).toEqual({ p50: 50, p95: 95 });
  });

  it("handles an empty clip", () => {
    const r = compareSources([]);
    expect(r.frames).toBe(0);
    expect(r.torsoPx).toBeNull();
    expect(joint(r, "left_knee").dropoutA).toBe(0);
  });
});

describe("percentile", () => {
  it("is NaN for no values", () => expect(percentile([], 50)).toBeNaN());
});
