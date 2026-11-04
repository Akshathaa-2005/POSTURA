import type { CocoKeypoint } from "./cocoAdapter";

/**
 * Pre/post-processing for the standard Ultralytics pose ONNX export (`yolo export format=onnx`), kept free of
 * onnxruntime and the DOM so it's unit-testable. Output layout is [1, 56, N]: per anchor, channels
 * 0-3 = box centre x/y + w/h (letterboxed input pixels), 4 = person score, 5.. = 17 × (x, y, score).
 */

const KEYPOINTS = 17;
export const OUTPUT_CHANNELS = 5 + KEYPOINTS * 3;

export interface Letterbox {
  size: number;
  scale: number;
  padX: number;
  padY: number;
  srcW: number;
  srcH: number;
}

/** Fit a srcW × srcH frame into a size × size square, centred, preserving aspect ratio. */
export function letterbox(srcW: number, srcH: number, size: number): Letterbox {
  const scale = Math.min(size / srcW, size / srcH);
  return { size, scale, padX: (size - srcW * scale) / 2, padY: (size - srcH * scale) / 2, srcW, srcH };
}

export interface YoloDetection {
  score: number;
  /** Normalised to the source frame. */
  box: { x1: number; y1: number; x2: number; y2: number };
  keypoints: CocoKeypoint[];
}

export interface DecodeOptions {
  scoreThreshold?: number;
  iouThreshold?: number;
  maxDetections?: number;
}

function iou(a: number[], b: number[]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

export function decodePose(data: ArrayLike<number>, numAnchors: number, lb: Letterbox, opts: DecodeOptions = {}): YoloDetection[] {
  const { scoreThreshold = 0.25, iouThreshold = 0.5, maxDetections = 1 } = opts;
  if (data.length !== OUTPUT_CHANNELS * numAnchors) {
    throw new Error(
      `Unexpected YOLO output size ${data.length}; expected ${OUTPUT_CHANNELS} × ${numAnchors}. ` +
        "Export with `yolo export format=onnx` (no nms / end2end) from a YOLOv8/YOLO11 -pose model.",
    );
  }
  const at = (c: number, i: number) => data[c * numAnchors + i];

  const candidates: { i: number; score: number; xyxy: number[] }[] = [];
  for (let i = 0; i < numAnchors; i++) {
    const score = at(4, i);
    if (score < scoreThreshold) continue;
    const cx = at(0, i);
    const cy = at(1, i);
    const hw = at(2, i) / 2;
    const hh = at(3, i) / 2;
    candidates.push({ i, score, xyxy: [cx - hw, cy - hh, cx + hw, cy + hh] });
  }
  candidates.sort((a, b) => b.score - a.score);

  const kept: typeof candidates = [];
  for (const c of candidates) {
    if (kept.length >= maxDetections) break;
    if (kept.every((k) => iou(k.xyxy, c.xyxy) < iouThreshold)) kept.push(c);
  }

  const toX = (x: number) => (x - lb.padX) / lb.scale / lb.srcW;
  const toY = (y: number) => (y - lb.padY) / lb.scale / lb.srcH;
  return kept.map(({ i, score, xyxy }) => ({
    score,
    box: { x1: toX(xyxy[0]), y1: toY(xyxy[1]), x2: toX(xyxy[2]), y2: toY(xyxy[3]) },
    keypoints: Array.from({ length: KEYPOINTS }, (_, k) => ({
      x: toX(at(5 + k * 3, i)),
      y: toY(at(6 + k * 3, i)),
      score: at(7 + k * 3, i),
    })),
  }));
}
