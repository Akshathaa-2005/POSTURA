/** Hand-drawn keyframes for the decorative exercise figures (viewBox 0 -8 100 124). */
export type FigurePoint = "head" | "lS" | "rS" | "lE" | "rE" | "lW" | "rW" | "lH" | "rH" | "lK" | "rK" | "lA" | "rA";
export type FigurePose = Record<FigurePoint, [number, number]>;

export const FIGURE_BONES: [FigurePoint, FigurePoint][] = [
  ["lS", "rS"], ["lS", "lH"], ["rS", "rH"], ["lH", "rH"],
  ["lS", "lE"], ["lE", "lW"], ["rS", "rE"], ["rE", "rW"],
  ["lH", "lK"], ["lK", "lA"], ["rH", "rK"], ["rK", "rA"],
];

const front: FigurePose = {
  head: [50, 14],
  lS: [40, 28], rS: [60, 28],
  lE: [36, 46], rE: [64, 46],
  lW: [34, 62], rW: [66, 62],
  lH: [44, 62], rH: [56, 62],
  lK: [44, 84], rK: [56, 84],
  lA: [44, 106], rA: [56, 106],
};

const side: FigurePose = {
  head: [50, 14],
  lS: [50, 28], rS: [50, 28],
  lE: [51, 45], rE: [51, 45],
  lW: [52, 61], rW: [52, 61],
  lH: [50, 62], rH: [50, 62],
  lK: [50, 84], rK: [50, 84],
  lA: [50, 106], rA: [50, 106],
};

type P = [number, number];

/** Side-view pose: arms and torso overlap, legs may differ (e.g. lunge). */
const sidePose = (o: { head: P; S: P; E: P; W: P; H: P; lK: P; rK: P; lA: P; rA: P }): FigurePose => ({
  head: o.head,
  lS: o.S, rS: o.S,
  lE: o.E, rE: o.E,
  lW: o.W, rW: o.W,
  lH: o.H, rH: o.H,
  lK: o.lK, rK: o.rK,
  lA: o.lA, rA: o.rA,
});

/** [start, peak] keyframes per exercise id. */
export const FIGURE_POSES: Record<string, [FigurePose, FigurePose]> = {
  jumping_jack: [
    front,
    {
      ...front,
      lE: [30, 16], rE: [70, 16],
      lW: [36, 2], rW: [64, 2],
      lK: [38, 84], rK: [62, 84],
      lA: [31, 106], rA: [69, 106],
    },
  ],
  squat: [
    side,
    sidePose({
      head: [52, 34], S: [48, 47], E: [60, 50], W: [73, 48], H: [35, 78],
      lK: [58, 80], rK: [58, 80], lA: [52, 106], rA: [52, 106],
    }),
  ],
  push_up: [
    sidePose({
      head: [85, 75], S: [76, 81], E: [76, 94], W: [76, 107], H: [46, 91],
      lK: [31, 97], rK: [31, 97], lA: [16, 105], rA: [16, 105],
    }),
    sidePose({
      head: [84, 93], S: [74, 98], E: [63, 94], W: [76, 107], H: [45, 101],
      lK: [30, 103], rK: [30, 103], lA: [16, 105], rA: [16, 105],
    }),
  ],
  lunge: [
    side,
    sidePose({
      head: [50, 30], S: [50, 44], E: [51, 60], W: [52, 75], H: [50, 77],
      lK: [64, 80], rK: [40, 102], lA: [64, 106], rA: [24, 104],
    }),
  ],
  bicep_curl: [
    side,
    { ...side, lW: [62, 33], rW: [62, 33] }, // elbow stays pinned, forearm curls up
  ],
  shoulder_press: [
    { ...side, lE: [57, 38], rE: [57, 38], lW: [55, 22], rW: [55, 22] }, // hands at shoulder height
    { ...side, lE: [58, 13], rE: [58, 13], lW: [60, -3], rW: [60, -3] }, // locked out, arms by the ears
  ],
};
