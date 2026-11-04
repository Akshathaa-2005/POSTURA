import { describe, expect, it } from "vitest";
import type { Exercise } from "@/types";
import { missingParts, partVisible, requiredParts } from "./framing";

const base = { id: "x", name: "X", category: "strength", difficulty: "beginner", duration_sec: 60, rep_target: 10, description: "", camera_setup: "", view: "side", faults: [], correction_tips: [], voice_intro: "", voice_encouragement: [] } as unknown as Exercise;

const vis = (seen: number[]) => Array.from({ length: 33 }, (_, i) => (seen.includes(i) ? 0.9 : 0.1));

describe("requiredParts", () => {
  it("uses the rep and fault metrics", () => {
    const press = { ...base, rep: { metric: "elbow" }, faults: [{ metric: "shoulder" }, { metric: "torso_lean" }] } as unknown as Exercise;
    expect(requiredParts(press)).toEqual(["shoulders", "elbows", "wrists", "hips"]);
  });
  it("includes knees and ankles for leg exercises", () => {
    const squat = { ...base, rep: { metric: "knee" }, faults: [{ metric: "knee" }, { metric: "torso_lean" }] } as unknown as Exercise;
    expect(requiredParts(squat)).toEqual(["shoulders", "hips", "knees", "ankles"]);
  });
  it("falls back to shoulders and hips", () => {
    expect(requiredParts({ ...base } as Exercise)).toEqual(["shoulders", "hips"]);
  });
});

describe("visibility", () => {
  it("a part counts as visible when either side is seen", () => {
    expect(partVisible(vis([11]), "shoulders")).toBe(true);
    expect(partVisible(vis([]), "shoulders")).toBe(false);
  });
  it("reports which required parts are missing", () => {
    expect(missingParts(vis([11, 12, 23, 24]), ["shoulders", "hips", "knees"])).toEqual(["knees"]);
  });
});
