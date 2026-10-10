// Benchmarks an exported form model on the WebAssembly (SIMD) backend of onnxruntime-web, the runtime the browser
// uses, and checks it reproduces Python's probabilities.
//   node scripts/bench-model.mjs ../backend/ml/artifacts/smoke/onnx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ort from "onnxruntime-web/wasm";

const dir = resolve(process.argv[2] ?? "../backend/ml/artifacts/smoke/onnx");
const runs = Number(process.argv[3] ?? 300);
ort.env.wasm.numThreads = 1; // the browser app isn't cross-origin isolated, so it runs single-threaded
const io = JSON.parse(readFileSync(resolve(dir, "model_io.json"), "utf8"));
const meta = JSON.parse(readFileSync(resolve(dir, "model_meta.json"), "utf8"));
const [, C, T, V] = meta.inputs.x;

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)];

for (const name of ["fp32", "int8"]) {
  const file = resolve(dir, `form_model.${name}.onnx`);
  const t0 = performance.now();
  const session = await ort.InferenceSession.create(readFileSync(file), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  const loadMs = performance.now() - t0;

  let maxDiff = 0;
  const feeds = io.cases.map((c) => ({
    x: new ort.Tensor("float32", Float32Array.from(c.x), [1, C, T, V]),
    ex: new ort.Tensor("int64", BigInt64Array.from([BigInt(c.ex)]), [1]),
  }));
  for (const [i, c] of io.cases.entries()) {
    const out = (await session.run(feeds[i])).probs.data;
    out.forEach((p, k) => (maxDiff = Math.max(maxDiff, Math.abs(p - c[name][k]))));
  }
  for (let i = 0; i < 20; i++) await session.run(feeds[0]); // warm-up
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await session.run(feeds[i % feeds.length]);
    times.push(performance.now() - t);
  }
  const mb = (readFileSync(file).length / 1e6).toFixed(3);
  console.log(
    `${name}: ${mb} MB | load ${loadMs.toFixed(0)} ms | run median ${median(times).toFixed(2)} ms, p95 ${pct(times, 0.95).toFixed(2)} ms | max |Δ| vs Python ${maxDiff.toExponential(1)}`,
  );
}
