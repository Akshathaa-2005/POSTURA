import { describe, expect, it } from "vitest";
import type { JointAngles } from "@/types";
import { computeGuidance, SpeechPacer, targetAngles, TOLERANCE_DEG } from "./poseGuidance";
import { EXERCISES } from "./exercises";

const target: JointAngles = { left_knee: 90, right_knee: 90, left_elbow: 170, right_elbow: 170 };

describe("targetAngles", () => {
  it("derives angles for every exercise from its peak pose", () => {
    for (const ex of EXERCISES) {
      const t = targetAngles(ex.id);
      expect(t, ex.id).not.toBeNull();
      expect(t!.left_knee).toBeGreaterThanOrEqual(0);
      expect(t!.left_knee).toBeLessThanOrEqual(180);
    }
  });
  it("is null for an unknown exercise", () => expect(targetAngles("nope")).toBeNull());
  it("squat peak has bent knees", () => expect(targetAngles("squat")!.left_knee).toBeLessThan(130));
});

describe("computeGuidance", () => {
  it("reports joint, current, target, direction and rounded delta, largest first", () => {
    const r = computeGuidance({ left_knee: 140, left_elbow: 150 }, target, ["left"]);
    expect(r.instructions.map((i) => i.joint)).toEqual(["left_knee", "left_elbow"]);
    expect(r.instructions[0]).toMatchObject({ current: 140, target: 90, delta: -50, direction: "decrease" });
    expect(r.instructions[0].text).toBe("Bend your left knee about 50 degrees.");
    expect(r.instructions[1]).toMatchObject({ delta: 20, direction: "increase" });
    expect(r.instructions[1].text).toBe("Straighten your left elbow about 20 degrees.");
  });
  it("stays silent inside the tolerance", () => {
    const r = computeGuidance({ left_knee: 90 + TOLERANCE_DEG, left_elbow: 170 }, target, ["left"]);
    expect(r.instructions).toEqual([]);
    expect(r.inPosition).toBe(true);
  });
  it("ignores the unseen side and joints that aren't visible", () => {
    const r = computeGuidance({ left_knee: 90, right_knee: 170 }, target, ["left"]);
    expect(r.compared).toBe(1);
    expect(r.inPosition).toBe(true);
    expect(computeGuidance({}, target).compared).toBe(0);
    expect(computeGuidance({}, target).inPosition).toBe(false);
  });
});

describe("SpeechPacer", () => {
  const off = (delta: number) => computeGuidance({ left_knee: 90 - delta }, target, ["left"]);

  it("speaks once, then not again within the repeat window", () => {
    const p = new SpeechPacer();
    expect(p.next(off(-50), 0)).toContain("knee");
    expect(p.next(off(-50), 1000)).toBeNull(); // too soon
    expect(p.next(off(-50), 5000)).toBeNull(); // same correction, still within repeat window
    expect(p.next(off(-50), 9000)).toContain("knee"); // lingered: remind
  });
  it("re-speaks early when the correction changes a lot", () => {
    const p = new SpeechPacer();
    p.next(off(-60), 0);
    expect(p.next(off(-30), 3500)).toContain("30 degrees");
  });
  it("says 'hold' once when the pose is reached, and again only after leaving it", () => {
    const p = new SpeechPacer();
    expect(p.next(off(0), 0)).toBe("Good. Hold this position.");
    expect(p.next(off(0), 10_000)).toBeNull();
    p.next(off(-50), 20_000);
    expect(p.next(off(0), 30_000)).toBe("Good. Hold this position.");
  });
  it("says nothing when no joints are visible", () => {
    expect(new SpeechPacer().next(computeGuidance({}, target), 0)).toBeNull();
  });
});
