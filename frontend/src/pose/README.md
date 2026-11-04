# Pose robustness layer

Wraps the MediaPipe (BlazePose) output so occluded or jittery joints don't corrupt rep counting and form scoring.
The public interface is unchanged: `usePoseDetection(...)` still calls `onResults(landmarks, info)` with 33 MediaPipe
landmarks, and `WorkoutEngine.process(...)` still returns an `EngineSnapshot`.

## Pipeline (per frame, inside `WorkoutEngine.process`)

```
MediaPipe landmarks
  → LandmarkSmoother      (pose/occlusion.ts)       One-Euro filter per landmark
  → LandmarkReliability   (utils/landmarkReliability.ts)  drops joints that are unseen, overlapping or mis-sized
  → GapFiller             (pose/occlusion.ts)       carries *unseen* joints for ≤ 300 ms
  → angles / metrics → RepCounter → rule evaluation → pose/repConstraints.ts (tempo) → score + cues
```

| Concern | Where | Behaviour |
|---|---|---|
| Jitter | `LandmarkSmoother` | Heavy smoothing when a joint is still, light when it moves fast. Speed is judged relative to torso length, so it behaves the same near or far from the camera. |
| Low confidence | `LandmarkReliability` | Smoothed visibility with hysteresis (`TRUST_ON` 0.6 / `TRUST_OFF` 0.4). Untrusted joints get visibility 0. |
| Implausible joints | `LandmarkReliability` | Crossed limbs (front view) and stretched limb segments are dropped. |
| Short occlusion | `GapFiller` | An *unseen* limb joint is placed at `parent_now + (joint − parent)_last_good` for up to `MAX_GAP_MS` (300 ms) at visibility `IMPUTED_VISIBILITY` (0.55, just above the 0.5 gate, below `TRUST_ON`). Joints dropped for *geometry* are never imputed: the model is mis-placing them, so their old position isn't a better answer. |
| Long occlusion | — | After the gap the joint is dropped; metrics depending on it become non-evaluable, and a rep with too many lost frames isn't counted. |
| Rep validity | `exercises.json` + `repConstraints.ts` | ROM (`peak_threshold`), form (`faults[]`), required-visible rules, and tempo (`min_duration_ms` / `max_duration_ms`). |

## Setup

```bash
cd frontend
npm install                      # postinstall downloads the MediaPipe WASM + model
npm test                         # vitest
npm run typecheck
```

Model variant (`lite` fastest · `full` default, better under occlusion · `heavy` most accurate, slowest):

```bash
# .env.local
NEXT_PUBLIC_POSE_MODEL_VARIANT=full
# then
npm run setup:mediapipe          # downloads public/mediapipe/models/pose_landmarker_<variant>.task
```

The GPU delegate is tried first and falls back to CPU automatically.

## Adding or tuning an exercise

Everything lives in `exercises/exercises.json` (shared with the backend). Rep exercise skeleton (values illustrative):

```jsonc
"squat": {
  "view": "side",                       // "front": judge both sides; "side": judge the camera-facing side only
  "rep": {
    "metric": "knee",                   // see METRIC_REGION in utils/poseValidation.ts for valid names
    "direction": "decrease",            // does the metric fall or rise on the way to the peak?
    "start_threshold": 160,             // back in the starting position beyond this
    "peak_threshold": 100,              // must reach this for the rep to count (ROM = 100%)
    "min_duration_ms": 800,             // optional: faster than this is a bounce → not counted
    "max_duration_ms": 8000             // optional: slower than this is a stall → not counted
  },
  "faults": [
    { "id": "shallow", "label": "Shallow", "when": "rep", "agg": "min", "metric": "knee",
      "op": ">", "warn": 110, "bad": 130, "cue": "Go a little deeper" }
  ]
}
```

- `when`: `always` / `active` (while moving or at the peak) / `peak` / `rep` (once per rep on its min/max, with `agg`).
- A fault fires when `metric op warn`; it is major (and the rep doesn't count) when `metric op bad` also holds.
- `required: true` + `unseen_cue` on a rep rule means "if this can't be seen, don't count the rep".
- `npm test` validates the catalog: threshold direction, `bad` beyond `warn`, reachable rep rules, tempo limits.

Tempo limits are opt-in; no shipped exercise sets them yet. Pick values from recorded reps (`duration_ms` is on every
`RepEvent`, and logged in dev) rather than guessing, or real reps will be rejected.

## Tuning

`DEFAULT_ONE_EURO` (`minCutoff`, `beta`, `dCutoff`), `MAX_GAP_MS` and `IMPUTED_VISIBILITY` in `occlusion.ts`.
Higher `minCutoff` = less lag at rest, more jitter. Higher `beta` = less lag when moving. Raising `MAX_GAP_MS`
trades robustness to dropouts for the risk of measuring stale positions.

## Swapping the pose backend later

`usePoseDetection` is the only code that touches MediaPipe; everything downstream consumes `Landmark[]` in the
33-point BlazePose layout (`LM` in `types/mediapipe.ts`) with a `visibility` per joint. A different model (e.g.
RTMPose via `onnxruntime-web`, already a dependency) only needs to emit that shape, mapping its keypoints onto the
`LM` indices and converting its scores to a 0–1 `visibility`. Models without heel/foot keypoints (MoveNet, COCO-17)
can't drive the exercises that use those metrics.

## YOLO-pose evaluation (experimental)

Opt-in in the live app: `usePoseDetection` uses YOLO when `NEXT_PUBLIC_POSE_BACKEND=yolo` or the URL has `?pose=yolo` (MediaPipe stays the default). Frames are skipped, not queued, while a YOLO inference is in flight. YOLO needs WebGPU to be usable: on WASM it ran at about 1 s per frame. `/dev/pose-compare` runs MediaPipe and a YOLO11/v8-pose ONNX model over a recorded clip and reports per-joint dropout, disagreement, jitter, joint-angle differences and latency.

| File | Role |
|---|---|
| `cocoAdapter.ts` | COCO-17 → the 33-slot `Landmark[]` the pipeline consumes. Unmapped slots get `visibility: 0`; `z` is 0; optional side-on foot synthesis. |
| `yoloDecode.ts` | Letterbox + decode/NMS for the standard Ultralytics ONNX output `[1, 56, N]`. |
| `yoloPose.ts` | onnxruntime-web session (WebGPU → WASM fallback) + canvas preprocessing. |
| `poseCompare.ts` | Pure metrics over per-frame results from both sources. |

Setup: export the model (`yolo export model=yolo11s-pose.pt format=onnx imgsz=640 opset=17 simplify=True`), put it at `public/models/yolo/yolo11s-pose.onnx`, run `npm run setup:ort` (now also copies the WebGPU runtime), then open `/dev/pose-compare` in `npm run dev`. The Ultralytics package is AGPL-3.0; check licensing before shipping its weights.
