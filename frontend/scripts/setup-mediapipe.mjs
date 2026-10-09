// Copies MediaPipe WASM runtime into /public and downloads the pose model,
// so the app runs fully self-hosted (no runtime CDN dependency).
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = path.join(root, "node_modules/@mediapipe/tasks-vision/wasm");
const outDir = path.join(root, "public/mediapipe");
const modelPath = path.join(outDir, "models/pose_landmarker_lite.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const exists = (p) => stat(p).then(() => true, () => false);

await mkdir(path.join(outDir, "models"), { recursive: true });
await cp(wasmSrc, path.join(outDir, "wasm"), { recursive: true });
console.log("[mediapipe] WASM runtime copied to public/mediapipe/wasm");

if (await exists(modelPath)) {
  console.log("[mediapipe] Pose model already present");
} else {
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(modelPath, Buffer.from(await res.arrayBuffer()));
    console.log("[mediapipe] Pose model downloaded to public/mediapipe/models");
  } catch (err) {
    console.warn(`[mediapipe] Could not download pose model (${err.message}).`);
    console.warn(`[mediapipe] Download it manually from ${MODEL_URL}\n            and save it to ${modelPath}`);
  }
}
