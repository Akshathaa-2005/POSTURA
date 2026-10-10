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

/** Lying on the back, head to the left (floor exercises). */
const supine = (o: Partial<FigurePose> = {}): FigurePose => ({
  head: [14, 98],
  lS: [24, 101], rS: [24, 101],
  lE: [36, 104], rE: [36, 104],
  lW: [48, 105], rW: [48, 105],
  lH: [52, 102], rH: [52, 102],
  lK: [68, 84], rK: [68, 84],
  lA: [82, 106], rA: [82, 106],
  ...o,
});

const pushUpTop = sidePose({
  head: [85, 75], S: [76, 81], E: [76, 94], W: [76, 107], H: [46, 91],
  lK: [31, 97], rK: [31, 97], lA: [16, 105], rA: [16, 105],
});

const hinged = sidePose({
  head: [76, 38], S: [66, 44], E: [66, 58], W: [66, 72], H: [40, 62],
  lK: [46, 84], rK: [46, 84], lA: [48, 106], rA: [48, 106],
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
    { ...side, lE: [54, 45], rE: [54, 45], lW: [56, 61], rW: [56, 61] },
    { ...side, lE: [54, 45], rE: [54, 45], lW: [65, 32], rW: [65, 32] }, // elbow stays pinned, forearm curls up
  ],
  shoulder_press: [
    { ...side, lE: [60, 32], rE: [60, 32], lW: [60, 18], rW: [60, 18] }, // dumbbells at shoulder height, forearms vertical
    { ...side, lE: [58, 13], rE: [58, 13], lW: [60, -3], rW: [60, -3] }, // locked out, arms by the ears
  ],
  high_knees: [
    { ...front, lE: [36, 44], lW: [40, 34], rE: [64, 46], rW: [66, 60] },
    { ...front, lK: [46, 64], lA: [45, 84], lE: [36, 46], lW: [34, 60], rE: [64, 44], rW: [60, 34] },
  ],
  glute_bridge: [supine(), supine({ head: [16, 98], lS: [26, 100], rS: [26, 100], lH: [54, 82], rH: [54, 82], lK: [72, 78], rK: [72, 78] })],
  plank: [pushUpTop, { ...pushUpTop, lH: [46, 90], rH: [46, 90], head: [85, 74] }],
  wall_sit: [
    sidePose({ head: [40, 34], S: [40, 48], E: [45, 62], W: [52, 72], H: [40, 78], lK: [62, 78], rK: [62, 78], lA: [62, 106], rA: [62, 106] }),
    sidePose({ head: [40, 33], S: [40, 47], E: [45, 61], W: [52, 71], H: [40, 78], lK: [62, 78], rK: [62, 78], lA: [62, 106], rA: [62, 106] }),
  ],
  side_plank: [
    {
      head: [84, 62], lS: [76, 70], rS: [76, 70], lE: [76, 88], lW: [76, 106], rE: [76, 52], rW: [76, 36],
      lH: [48, 84], rH: [48, 84], lK: [32, 94], rK: [32, 94], lA: [16, 104], rA: [16, 104],
    },
    {
      head: [84, 61], lS: [76, 69], rS: [76, 69], lE: [76, 88], lW: [76, 106], rE: [76, 51], rW: [76, 35],
      lH: [48, 82], rH: [48, 82], lK: [32, 93], rK: [32, 93], lA: [16, 104], rA: [16, 104],
    },
  ],
  sumo_squat: [
    { ...front, lK: [40, 84], rK: [60, 84], lA: [36, 106], rA: [64, 106], lE: [42, 46], rE: [58, 46], lW: [47, 56], rW: [53, 56] },
    {
      head: [50, 32], lS: [40, 46], rS: [60, 46], lE: [42, 62], rE: [58, 62], lW: [48, 56], rW: [52, 56],
      lH: [44, 80], rH: [56, 80], lK: [32, 88], rK: [68, 88], lA: [36, 106], rA: [64, 106],
    },
  ],
  lateral_raise: [front, { ...front, lE: [24, 31], rE: [76, 31], lW: [10, 30], rW: [90, 30] }],
  front_raise: [side, { ...side, lE: [66, 30], rE: [66, 30], lW: [82, 30], rW: [82, 30] }],
  overhead_tricep_extension: [
    { ...side, lE: [53, 11], rE: [53, 11], lW: [41, 20], rW: [41, 20] },
    { ...side, lE: [53, 11], rE: [53, 11], lW: [55, -5], rW: [55, -5] },
  ],
  hip_hinge: [side, hinged],
  reverse_lunge: [
    side,
    sidePose({
      head: [52, 30], S: [52, 44], E: [53, 60], W: [54, 75], H: [52, 77],
      lK: [66, 80], rK: [42, 102], lA: [66, 106], rA: [26, 104],
    }),
  ],
  knee_push_up: [
    sidePose({ head: [85, 75], S: [76, 81], E: [76, 94], W: [76, 107], H: [50, 92], lK: [32, 106], rK: [32, 106], lA: [18, 96], rA: [18, 96] }),
    sidePose({ head: [84, 93], S: [74, 98], E: [63, 94], W: [76, 107], H: [49, 101], lK: [32, 106], rK: [32, 106], lA: [18, 96], rA: [18, 96] }),
  ],
  side_lunge: [
    { ...front, lK: [42, 84], rK: [58, 84], lA: [40, 106], rA: [60, 106] },
    {
      head: [44, 30], lS: [36, 44], rS: [54, 44], lE: [36, 58], rE: [54, 58], lW: [40, 70], rW: [52, 70],
      lH: [38, 74], rH: [50, 74], lK: [28, 88], rK: [62, 90], lA: [28, 106], rA: [74, 106],
    },
  ],
  bent_over_row: [hinged, { ...hinged, lE: [54, 48], rE: [54, 48], lW: [60, 60], rW: [60, 60] }],
  sit_up: [
    supine({ lE: [32, 96], rE: [32, 96], lW: [28, 94], rW: [28, 94] }),
    supine({ head: [48, 58], lS: [44, 72], rS: [44, 72], lE: [50, 82], rE: [50, 82], lW: [46, 76], rW: [46, 76] }),
  ],
  leg_raise: [
    supine({ lK: [72, 102], rK: [72, 102], lA: [92, 103], rA: [92, 103] }),
    supine({ lK: [62, 84], rK: [62, 84], lA: [70, 64], rA: [70, 64] }),
  ],
};
