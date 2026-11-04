import { describe, expect, it } from "vitest";
import { decodePose, letterbox, OUTPUT_CHANNELS } from "./yoloDecode";

const N = 6;

/** Writes one anchor into a channel-major [56, N] buffer. */
function put(data: Float32Array, i: number, box: [number, number, number, number], score: number, kp: [number, number, number]) {
  [...box, score].forEach((v, c) => (data[c * N + i] = v));
  for (let k = 0; k < 17; k++) kp.forEach((v, j) => (data[(5 + k * 3 + j) * N + i] = v));
}

describe("letterbox", () => {
  it("pads the short side and keeps aspect ratio", () => {
    const lb = letterbox(1280, 720, 640);
    expect(lb.scale).toBe(0.5);
    expect(lb.padX).toBe(0);
    expect(lb.padY).toBe(140);
  });
});

describe("decodePose", () => {
  const lb = letterbox(1280, 720, 640);

  it("maps letterboxed pixels back to normalised source coordinates", () => {
    const data = new Float32Array(OUTPUT_CHANNELS * N);
    put(data, 2, [320, 320, 100, 200], 0.9, [320, 140 + 180, 0.8]); // keypoint at source (640, 360)
    const [d] = decodePose(data, N, lb);
    expect(d.score).toBeCloseTo(0.9);
    expect(d.keypoints[0].x).toBeCloseTo(0.5);
    expect(d.keypoints[0].y).toBeCloseTo(0.5);
    expect(d.keypoints[16].score).toBeCloseTo(0.8);
    expect(d.box.x1).toBeCloseTo((270 / 0.5) / 1280);
  });

  it("drops low scores and suppresses overlapping duplicates", () => {
    const data = new Float32Array(OUTPUT_CHANNELS * N);
    put(data, 0, [300, 300, 100, 200], 0.9, [300, 300, 1]);
    put(data, 1, [302, 300, 100, 200], 0.8, [302, 300, 1]); // same person
    put(data, 2, [500, 300, 60, 100], 0.7, [500, 300, 1]); // someone else
    put(data, 3, [100, 300, 60, 100], 0.1, [100, 300, 1]); // below threshold
    const all = decodePose(data, N, lb, { maxDetections: 5 });
    expect(all.map((d) => d.score.toFixed(1))).toEqual(["0.9", "0.7"]);
    expect(decodePose(data, N, lb)).toHaveLength(1);
  });

  it("returns nothing for an empty frame and rejects an unexpected layout", () => {
    expect(decodePose(new Float32Array(OUTPUT_CHANNELS * N), N, lb)).toEqual([]);
    expect(() => decodePose(new Float32Array(10), N, lb)).toThrow(/Unexpected YOLO output/);
  });
});
