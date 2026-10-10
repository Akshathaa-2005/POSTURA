import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Landmark } from "@/types/mediapipe";
import { CONTEXT_DIM, normalizeFrame, resample, T, toModelInput, V, type Transform } from "./skeleton";

interface Case {
  width: number;
  height: number;
  frames: number[][][];
  joints: number[][][];
  context: number[][];
  resampled_joints: number[][];
  model_input: number[];
}
const golden: { cases: Case[] } = JSON.parse(
  readFileSync(resolve(__dirname, "../../../backend/ml/fixtures/normalize_golden.json"), "utf8"),
);

const toLandmarks = (f: number[][]): Landmark[] => f.map(([x, y, v]) => ({ x, y, z: 0, visibility: v }));
const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 1e-6) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i]), `index ${i}`).toBeLessThan(tol);
};

describe("skeleton normalisation matches the Python implementation", () => {
  it.each(golden.cases.map((c, i) => [i, c] as const))("golden case %i", (_, c) => {
    let prev: Transform | null = null;
    const joints = new Float64Array(c.frames.length * V * 3);
    const context = new Float64Array(c.frames.length * CONTEXT_DIM);
    c.frames.forEach((f, t) => {
      const n = normalizeFrame(toLandmarks(f), c.width, c.height, prev);
      prev = n.transform;
      close(n.joints, c.joints[t].flat());
      close(n.context, c.context[t]);
      joints.set(n.joints, t * V * 3);
      context.set(n.context, t * CONTEXT_DIM);
    });
    const rj = resample(joints, c.frames.length, V * 3, T);
    close(rj, c.resampled_joints.flat());
    const rc = resample(context, c.frames.length, CONTEXT_DIM, T);
    close(toModelInput(rj, rc), c.model_input, 1e-5);
  });
});

describe("normalisation invariances", () => {
  const frame = golden.cases[0].frames[8];
  const { width, height } = golden.cases[0];
  const base = normalizeFrame(toLandmarks(frame), width, height, null);

  const transformed = (f: (x: number, y: number) => [number, number]) =>
    toLandmarks(frame.map(([x, y, v]) => [...f(x * width, y * height).map((p, i) => p / (i ? height : width)), v]));

  it("ignores where the person is in the frame and how far away", () => {
    const moved = transformed((x, y) => [(x - width / 2) * 0.6 + width * 0.4, (y - height / 2) * 0.6 + height * 0.55]);
    close(normalizeFrame(moved, width, height, null).joints, base.joints, 1e-9);
  });

  it("ignores camera roll", () => {
    const a = (25 * Math.PI) / 180;
    const rolled = transformed((x, y) => [x * Math.cos(a) - y * Math.sin(a) + 300, x * Math.sin(a) + y * Math.cos(a) + 100]);
    close(normalizeFrame(rolled, width, height, null).joints, base.joints, 1e-9);
  });
});
