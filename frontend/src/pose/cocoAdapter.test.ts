import { describe, expect, it } from "vitest";
import { LM } from "@/types/mediapipe";
import { COCO_NAMES, COCO_TO_LM, cocoToLandmarks, type CocoKeypoint } from "./cocoAdapter";

/** Keypoint k sits at (k/100, k/50) with score 0.9, so any misrouted index shows up. */
const kps = (): CocoKeypoint[] => COCO_NAMES.map((_, k) => ({ x: k / 100, y: k / 50, score: 0.9 }));

describe("cocoToLandmarks", () => {
  it("places each COCO keypoint in its MediaPipe slot", () => {
    const lm = cocoToLandmarks(kps());
    expect(lm).toHaveLength(33);
    COCO_TO_LM.forEach((slot, k) => {
      expect(lm[slot]).toEqual({ x: k / 100, y: k / 50, z: 0, visibility: 0.9 });
    });
    expect(lm[LM.LEFT_WRIST].x).toBe(0.09);
    expect(lm[LM.RIGHT_ANKLE].x).toBe(0.16);
  });

  it("leaves slots COCO lacks invisible but at a nearby position", () => {
    const lm = cocoToLandmarks(kps());
    for (const slot of [1, 3, 4, 6, 9, 10, 17, 18, 19, 20, 21, 22, LM.LEFT_HEEL, LM.RIGHT_FOOT_INDEX]) {
      expect(lm[slot].visibility).toBe(0);
    }
    expect(lm[LM.LEFT_HEEL]).toMatchObject({ x: lm[LM.LEFT_ANKLE].x, y: lm[LM.LEFT_ANKLE].y });
    expect(lm[19]).toMatchObject({ x: lm[LM.LEFT_WRIST].x });
  });

  it("zeroes visibility for off-frame or non-finite keypoints and clamps scores", () => {
    const k = kps();
    k[LM.NOSE] = { x: 1.5, y: 0.2, score: 0.99 };
    k[1] = { x: 0.5, y: 0.5, score: NaN };
    k[2] = { x: 0.5, y: 0.5, score: 1.3 };
    const lm = cocoToLandmarks(k);
    expect(lm[LM.NOSE].visibility).toBe(0);
    expect(lm[LM.LEFT_EYE].visibility).toBe(0);
    expect(lm[LM.RIGHT_EYE].visibility).toBe(1);
  });

  it("rejects a wrong keypoint count", () => {
    expect(() => cocoToLandmarks(kps().slice(0, 16))).toThrow(/17/);
  });

  describe("synthesizeFeet", () => {
    /** Side-on figure: nose well ahead of the shoulders (to the right), shin vertical. */
    const side = (): CocoKeypoint[] => {
      const k = kps().map((p) => ({ ...p, score: 0.9 }));
      k[0] = { x: 0.62, y: 0.1, score: 0.9 };
      k[5] = { x: 0.5, y: 0.25, score: 0.9 };
      k[6] = { x: 0.51, y: 0.25, score: 0.9 };
      k[13] = { x: 0.5, y: 0.7, score: 0.9 };
      k[15] = { x: 0.5, y: 0.9, score: 0.9 };
      return k;
    };

    it("is off by default", () => {
      expect(cocoToLandmarks(side())[LM.LEFT_FOOT_INDEX].visibility).toBe(0);
    });

    it("points the toes the way the face points when side-on", () => {
      const lm = cocoToLandmarks(side(), { synthesizeFeet: true });
      expect(lm[LM.LEFT_FOOT_INDEX].x).toBeGreaterThan(lm[LM.LEFT_ANKLE].x);
      expect(lm[LM.LEFT_HEEL].x).toBeLessThan(lm[LM.LEFT_ANKLE].x);
      expect(lm[LM.LEFT_FOOT_INDEX].visibility).toBeCloseTo(0.72);
    });

    it("flips with the facing direction", () => {
      const k = side();
      k[0] = { x: 0.38, y: 0.1, score: 0.9 };
      const lm = cocoToLandmarks(k, { synthesizeFeet: true });
      expect(lm[LM.LEFT_FOOT_INDEX].x).toBeLessThan(lm[LM.LEFT_ANKLE].x);
    });

    it("does nothing when facing the camera", () => {
      const k = side();
      k[0] = { x: 0.505, y: 0.1, score: 0.9 };
      expect(cocoToLandmarks(k, { synthesizeFeet: true })[LM.LEFT_FOOT_INDEX].visibility).toBe(0);
    });
  });
});
