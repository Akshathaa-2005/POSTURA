import { LM, type Landmark } from "@/types/mediapipe";

/**
 * Adapter from a COCO-17 pose model (YOLOv8/YOLO11-pose) to the 33-slot MediaPipe layout the rest of the app
 * (`LandmarkSmoother`, `LandmarkReliability`, `WorkoutEngine`, `kinematicSolver`) already consumes. Pure TypeScript.
 *
 * Slots COCO has no equivalent for (eye corners, mouth, hand points, heel / foot index) are returned with
 * `visibility: 0` so every downstream visibility gate drops them. Their x/y borrow a nearby joint so code that
 * ignores visibility still reads a sane position. `z` is always 0: YOLO-pose is 2D only.
 */

/** COCO keypoint order, as emitted by YOLOv8/YOLO11-pose. */
export const COCO_NAMES = [
  "nose",
  "left_eye",
  "right_eye",
  "left_ear",
  "right_ear",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
] as const;

/** MediaPipe landmark index for each COCO keypoint, in COCO order. */
export const COCO_TO_LM = [
  LM.NOSE,
  LM.LEFT_EYE,
  LM.RIGHT_EYE,
  LM.LEFT_EAR,
  LM.RIGHT_EAR,
  LM.LEFT_SHOULDER,
  LM.RIGHT_SHOULDER,
  LM.LEFT_ELBOW,
  LM.RIGHT_ELBOW,
  LM.LEFT_WRIST,
  LM.RIGHT_WRIST,
  LM.LEFT_HIP,
  LM.RIGHT_HIP,
  LM.LEFT_KNEE,
  LM.RIGHT_KNEE,
  LM.LEFT_ANKLE,
  LM.RIGHT_ANKLE,
] as const;

/** A COCO keypoint in normalised image coordinates (0..1, origin top-left) with the model's confidence. */
export interface CocoKeypoint {
  x: number;
  y: number;
  score: number;
}

export const LANDMARK_COUNT = 33;

/** Unmapped MediaPipe slots and the mapped slot whose position each one borrows. */
const BORROW: [slots: number[], from: number][] = [
  [[1, 3], LM.LEFT_EYE],
  [[4, 6], LM.RIGHT_EYE],
  [[9, 10], LM.NOSE],
  [[17, 19, 21], LM.LEFT_WRIST],
  [[18, 20, 22], LM.RIGHT_WRIST],
  [[LM.LEFT_HEEL, LM.LEFT_FOOT_INDEX], LM.LEFT_ANKLE],
  [[LM.RIGHT_HEEL, LM.RIGHT_FOOT_INDEX], LM.RIGHT_ANKLE],
];

/** A keypoint this far outside the frame is the model guessing, not seeing. */
const OFF_FRAME_MARGIN = 0.02;

export interface AdapterOptions {
  /** Frame width / height. Needed so synthesised foot geometry isn't skewed on non-square frames. Default 1. */
  aspect?: number;
  /**
   * Estimate heel and foot-index from the shank when the user is side-on. Off by default: the estimate is a
   * heuristic with no depth, and `kinematicSolver` uses these points for facing direction.
   */
  synthesizeFeet?: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const empty = (): Landmark => ({ x: 0, y: 0, z: 0, visibility: 0 });

export function cocoToLandmarks(kps: ArrayLike<CocoKeypoint>, opts: AdapterOptions = {}): Landmark[] {
  if (kps.length !== COCO_TO_LM.length) throw new Error(`Expected ${COCO_TO_LM.length} COCO keypoints, got ${kps.length}`);
  const out: Landmark[] = Array.from({ length: LANDMARK_COUNT }, empty);

  for (let c = 0; c < COCO_TO_LM.length; c++) {
    const k = kps[c];
    const offFrame = k.x < -OFF_FRAME_MARGIN || k.x > 1 + OFF_FRAME_MARGIN || k.y < -OFF_FRAME_MARGIN || k.y > 1 + OFF_FRAME_MARGIN;
    out[COCO_TO_LM[c]] = {
      x: k.x,
      y: k.y,
      z: 0,
      visibility: offFrame || !Number.isFinite(k.score) ? 0 : clamp01(k.score),
    };
  }
  for (const [slots, from] of BORROW) {
    for (const s of slots) out[s] = { x: out[from].x, y: out[from].y, z: 0, visibility: 0 };
  }

  if (opts.synthesizeFeet) addFeet(out, opts.aspect ?? 1);
  return out;
}

/** Side-on only: with the nose clearly offset from the shoulders we know which way the toes point. */
const SIDE_ON_NOSE_OFFSET = 0.35; // of shoulder width
const FEET_VISIBILITY_SCALE = 0.8;

function addFeet(lm: Landmark[], aspect: number) {
  const nose = lm[LM.NOSE];
  const ls = lm[LM.LEFT_SHOULDER];
  const rs = lm[LM.RIGHT_SHOULDER];
  if (nose.visibility === 0 || ls.visibility === 0 || rs.visibility === 0) return;
  const shoulderW = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y);
  const dx = (nose.x - (ls.x + rs.x) / 2) * aspect;
  if (shoulderW === 0 || Math.abs(dx) < SIDE_ON_NOSE_OFFSET * shoulderW) return;
  const facing = Math.sign(dx);

  for (const [knee, ankle, heel, toe] of [
    [LM.LEFT_KNEE, LM.LEFT_ANKLE, LM.LEFT_HEEL, LM.LEFT_FOOT_INDEX],
    [LM.RIGHT_KNEE, LM.RIGHT_ANKLE, LM.RIGHT_HEEL, LM.RIGHT_FOOT_INDEX],
  ] as const) {
    const k = lm[knee];
    const a = lm[ankle];
    const visibility = Math.min(k.visibility, a.visibility) * FEET_VISIBILITY_SCALE;
    if (visibility === 0) continue;
    const shank = Math.hypot((a.x - k.x) * aspect, a.y - k.y);
    lm[heel] = { x: a.x - (facing * 0.15 * shank) / aspect, y: a.y + 0.12 * shank, z: 0, visibility };
    lm[toe] = { x: a.x + (facing * 0.4 * shank) / aspect, y: a.y + 0.15 * shank, z: 0, visibility };
  }
}
