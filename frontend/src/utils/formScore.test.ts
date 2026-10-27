import { describe, expect, it } from "vitest";
import type { FaultHit, FaultRule } from "@/types";
import { MIN_COVERAGE, scoreFrame, visibleFraction, type FrameScoreInput } from "./formScore";

const rule = (id: string): FaultRule => ({ id, label: id, when: "active", metric: "knee", op: "<", warn: 1, cue: id });
const hit = (id: string, status: "warn" | "bad"): FaultHit => ({ rule: rule(id), status, sides: [], value: 0 });

const base: FrameScoreInput = {
  inFrame: true,
  visibleFraction: 1,
  setupOk: true,
  active: true,
  rules: [rule("a"), rule("b")].map((r) => ({ rule: r, evaluable: true })),
  hits: [],
  repQuality: null,
};

describe("scoreFrame", () => {
  it("scores a fully measured, clean frame 100", () => expect(scoreFrame(base).score).toBe(100));

  it.each([
    ["no_pose", { inFrame: false }],
    ["low_visibility", { visibleFraction: 0.5 }],
    ["not_in_position", { setupOk: false }],
    ["idle", { active: false }],
  ] as const)("returns null (%s)", (reason, patch) => {
    expect(scoreFrame({ ...base, ...patch })).toMatchObject({ score: null, skip: reason });
  });

  it("applies fault penalties", () => {
    expect(scoreFrame({ ...base, hits: [hit("a", "warn")] }).score).toBe(85);
    expect(scoreFrame({ ...base, hits: [hit("a", "bad"), hit("b", "bad"), hit("c", "bad")] }).score).toBe(0);
  });

  it("treats unmeasurable rules as unknown: too few measured means no score", () => {
    const rules = [rule("a"), rule("b"), rule("c")].map((r, i) => ({ rule: r, evaluable: i === 0 }));
    expect(scoreFrame({ ...base, rules })).toMatchObject({ score: null, skip: "low_coverage" });
  });

  it("caps partially-verified frames below 100", () => {
    const rules = [rule("a"), rule("b"), rule("c")].map((r, i) => ({ rule: r, evaluable: i < 2 })); // 2/3 measured
    const f = scoreFrame({ ...base, rules });
    expect(f.coverage).toBeGreaterThanOrEqual(MIN_COVERAGE);
    expect(f.score).toBeCloseTo(100 - (1 - 2 / 3) * 50, 5);
  });

  it("with nothing to check live, scores only from a finished rep", () => {
    expect(scoreFrame({ ...base, rules: [] })).toMatchObject({ score: null, skip: "nothing_to_assess" });
    expect(scoreFrame({ ...base, rules: [], repQuality: 85 }).score).toBe(85);
  });

  it("blends the last rep's quality", () => expect(scoreFrame({ ...base, repQuality: 70 }).score).toBe(85));
});

describe("visibleFraction", () => {
  const lm = (visible: number[]) => Array.from({ length: 33 }, (_, i) => ({ x: 0, y: 0, z: 0, visibility: visible.includes(i) ? 0.9 : 0 }));
  it("counts only the judged side", () => {
    const left = [11, 13, 15, 23, 25, 27];
    expect(visibleFraction(lm(left), ["left"])).toBe(1);
    expect(visibleFraction(lm(left), ["left", "right"])).toBe(0.5);
    expect(visibleFraction(lm([]), [])).toBe(0);
  });
});
