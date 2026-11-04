import { describe, expect, it } from "vitest";
import type { Landmark } from "@/types/mediapipe";
import { LandmarkReliability } from "./landmarkReliability";

const W = 1000;
const H = 1000;
type P = [number, number];

/** Front-facing figure, torso 300 px tall. Arms hang down unless overridden. */
function figure(over: Record<number, P> = {}, vis: Record<number, number> = {}): Landmark[] {
  const pts: Record<number, P> = {
    11: [550, 300], 12: [450, 300], 13: [580, 420], 14: [420, 420], 15: [600, 540], 16: [400, 540],
    23: [530, 600], 24: [470, 600], 25: [540, 750], 26: [460, 750], 27: [545, 900], 28: [455, 900],
    ...over,
  };
  return Array.from({ length: 33 }, (_, i) => {
    const p = pts[i];
    return p ? { x: p[0] / W, y: p[1] / H, z: 0, visibility: vis[i] ?? 0.95 } : { x: 0.5, y: 0.5, z: 0, visibility: 0 };
  });
}

const feed = (r: LandmarkReliability, lm: Landmark[], n: number, front = true) => {
  let out = r.sanitize(lm, W, H, front);
  for (let i = 1; i < n; i++) out = r.sanitize(lm, W, H, front);
  return out;
};

describe("LandmarkReliability", () => {
  it("trusts a clearly visible body", () => {
    expect(feed(new LandmarkReliability(), figure(), 3).unreliable).toEqual([]);
  });

  it("drops joints with low visibility and uses hysteresis to bring them back", () => {
    const r = new LandmarkReliability();
    feed(r, figure(), 3);
    expect(feed(r, figure({}, { 15: 0.5 }), 1).unreliable).not.toContain(15); // dips but stays trusted
    expect(feed(r, figure({}, { 15: 0.1 }), 4).unreliable).toContain(15); // clearly gone
    expect(feed(r, figure({}, { 15: 0.55 }), 4).unreliable).toContain(15); // not convincing yet
    expect(feed(r, figure({}, { 15: 0.9 }), 6).unreliable).not.toContain(15); // back, re-trusted
  });

  it("flags crossed arms (wrists on the opposite elbows) in front view", () => {
    const r = new LandmarkReliability();
    feed(r, figure(), 3);
    const crossed = figure({ 15: [420, 420], 16: [580, 420] });
    const out = feed(r, crossed, 2);
    expect(out.unreliable).toEqual(expect.arrayContaining([15, 16]));
    expect(out.landmarks[15].visibility).toBe(0);
  });

  it("does not treat clapped hands or touching knees as occlusion", () => {
    const r = new LandmarkReliability();
    const clap = figure({ 13: [520, 200], 14: [480, 200], 15: [502, 100], 16: [498, 100], 25: [505, 750], 26: [495, 750] });
    expect(feed(r, clap, 3).unreliable).toEqual([]);
  });

  it("skips the overlap check in side view, where limbs legitimately coincide", () => {
    const r = new LandmarkReliability();
    const side = figure({ 15: [420, 420], 16: [580, 420] });
    expect(feed(r, side, 3, false).unreliable).toEqual([]);
  });

  it("flags a limb end the model flung far from where it belongs, after a warm-up", () => {
    const r = new LandmarkReliability();
    feed(r, figure(), 30);
    const flung = feed(r, figure({ 15: [950, 150] }), 1); // forearm now ~4x its normal length
    expect(flung.unreliable).toContain(15);
    expect(flung.unreliable).not.toContain(13);
  });

  it("holds a flagged joint out for a few frames so it can't flicker", () => {
    const r = new LandmarkReliability();
    feed(r, figure(), 30);
    feed(r, figure({ 15: [950, 150] }), 1);
    expect(r.sanitize(figure(), W, H, true).unreliable).toContain(15);
    expect(feed(r, figure(), 6).unreliable).not.toContain(15);
  });
});
