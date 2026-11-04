import { describe, expect, it } from "vitest";
import { LM, type Landmark } from "@/types/mediapipe";
import { GapFiller, IMPUTED_VISIBILITY, LandmarkSmoother, MAX_GAP_MS, OneEuroFilter } from "./occlusion";

const FRAME = 33;

/** Deterministic uniform noise in [-1, 1]. */
function noise(seed = 7) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
}

describe("OneEuroFilter", () => {
  it("removes jitter from a still joint", () => {
    const rnd = noise();
    const f = new OneEuroFilter();
    let sumSq = 0;
    let n = 0;
    for (let i = 0; i < 300; i++) {
      const y = f.filter(0.5 + 0.004 * rnd(), i * FRAME);
      if (i > 30) {
        sumSq += (y - 0.5) ** 2;
        n++;
      }
    }
    const rms = Math.sqrt(sumSq / n);
    const rawRms = 0.004 / Math.sqrt(3);
    expect(rms).toBeLessThan(0.65 * rawRms); // the old fixed EMA (alpha 0.6) leaves ~65%
  });

  it("follows a fast movement without lagging behind", () => {
    const f = new OneEuroFilter();
    const out = [...Array(10).fill(0), 1, 2, 3, 4, 5, 6].map((k, i) => f.filter(k === 0 ? 0 : (0.1 * k) / 6, i * FRAME));
    expect(out[out.length - 1]).toBeGreaterThan(0.1 * 0.9); // within 10% of the target by the end of the ramp
  });

  it("survives duplicate timestamps", () => {
    const f = new OneEuroFilter();
    f.filter(0.2, 100);
    expect(Number.isFinite(f.filter(0.3, 100))).toBe(true);
  });
});

function pose(torso: number): Landmark[] {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.99 }));
  lm[LM.LEFT_SHOULDER] = { ...lm[0], x: 0.45, y: 0.3 };
  lm[LM.RIGHT_SHOULDER] = { ...lm[0], x: 0.55, y: 0.3 };
  lm[LM.LEFT_HIP] = { ...lm[0], x: 0.45, y: 0.3 + torso };
  lm[LM.RIGHT_HIP] = { ...lm[0], x: 0.55, y: 0.3 + torso };
  return lm;
}

describe("LandmarkSmoother", () => {
  it("smooths the same whether the body is near or far (speed is judged relative to torso length)", () => {
    const run = (torso: number) => {
      const s = new LandmarkSmoother();
      let y = 0;
      for (let i = 0; i < 20; i++) {
        const lm = pose(torso);
        lm[LM.LEFT_WRIST] = { ...lm[0], y: 0.5 + (i < 8 ? 0 : (torso * 1.2 * Math.min(i - 8, 6)) / 6) };
        y = (s.smooth(lm, i * FRAME)[LM.LEFT_WRIST].y - 0.5) / torso;
      }
      return y;
    };
    expect(Math.abs(run(0.4) - run(0.15))).toBeLessThan(0.02);
  });

  it("leaves visibility untouched", () => {
    const s = new LandmarkSmoother();
    const lm = pose(0.25);
    lm[LM.NOSE].visibility = 0.123;
    expect(s.smooth(lm, 0)[LM.NOSE].visibility).toBe(0.123);
  });
});

describe("GapFiller", () => {
  const shoulderX = (x: number): Landmark[] => {
    const lm = pose(0.25);
    lm[LM.LEFT_SHOULDER] = { ...lm[0], x, y: 0.3 };
    lm[LM.LEFT_ELBOW] = { ...lm[0], x: x - 0.05, y: 0.45 };
    lm[LM.LEFT_WRIST] = { ...lm[0], x: x - 0.05, y: 0.6 };
    return lm;
  };
  const dropped = (lm: Landmark[], ids: number[]) => lm.map((p, i) => (ids.includes(i) ? { ...p, visibility: 0 } : p));

  it("carries a briefly hidden joint along with its parent", () => {
    const g = new GapFiller();
    g.apply(shoulderX(0.45), [], [], 0);
    // Elbow and wrist vanish while the whole arm drifts 0.1 to the right.
    const moved = dropped(shoulderX(0.55), [LM.LEFT_ELBOW, LM.LEFT_WRIST]);
    const { landmarks, imputed } = g.apply(moved, [LM.LEFT_ELBOW, LM.LEFT_WRIST], [LM.LEFT_ELBOW, LM.LEFT_WRIST], FRAME);
    expect(imputed).toEqual([LM.LEFT_ELBOW, LM.LEFT_WRIST]);
    expect(landmarks[LM.LEFT_ELBOW].x).toBeCloseTo(0.5, 6);
    expect(landmarks[LM.LEFT_ELBOW].y).toBeCloseTo(0.45, 6);
    expect(landmarks[LM.LEFT_WRIST].x).toBeCloseTo(0.5, 6); // followed the imputed elbow
    expect(landmarks[LM.LEFT_WRIST].visibility).toBe(IMPUTED_VISIBILITY);
  });

  it("gives up after MAX_GAP_MS and recovers when the joint returns", () => {
    const g = new GapFiller();
    g.apply(shoulderX(0.45), [], [], 0);
    const gone = dropped(shoulderX(0.45), [LM.LEFT_ELBOW]);
    expect(g.apply(gone, [LM.LEFT_ELBOW], [LM.LEFT_ELBOW], MAX_GAP_MS).imputed).toEqual([LM.LEFT_ELBOW]);
    const late = g.apply(gone, [LM.LEFT_ELBOW], [LM.LEFT_ELBOW], MAX_GAP_MS + 1);
    expect(late.imputed).toEqual([]);
    expect(late.landmarks[LM.LEFT_ELBOW].visibility).toBe(0);
    expect(g.apply(shoulderX(0.45), [], [], MAX_GAP_MS + 2).imputed).toEqual([]);
  });

  it("never imputes a joint that was dropped for geometry rather than for being unseen", () => {
    const g = new GapFiller();
    g.apply(shoulderX(0.45), [], [], 0);
    const flagged = dropped(shoulderX(0.45), [LM.LEFT_ELBOW]);
    const { imputed } = g.apply(flagged, [LM.LEFT_ELBOW], [], FRAME);
    expect(imputed).toEqual([]);
  });

  it("has nothing to impute for a joint that was never seen", () => {
    const g = new GapFiller();
    const lm = dropped(shoulderX(0.45), [LM.LEFT_ELBOW]);
    expect(g.apply(lm, [LM.LEFT_ELBOW], [LM.LEFT_ELBOW], 0).imputed).toEqual([]);
  });
});
