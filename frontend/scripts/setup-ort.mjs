// Copies the onnxruntime-web WebAssembly (SIMD) runtime into /public/ort so the form model runs self-hosted.
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules/onnxruntime-web/dist");
const out = path.join(root, "public/ort");

await mkdir(out, { recursive: true });
for (const f of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  await cp(path.join(src, f), path.join(out, f));
}
console.log("[ort] WebAssembly runtime copied to public/ort");
