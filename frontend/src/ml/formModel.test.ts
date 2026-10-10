import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as ort from "onnxruntime-web/wasm";
import { FormModel, type FormModelMeta } from "./formModel";
import { V } from "./skeleton";

// Uses the pipeline-smoke model exported by `python -m ml.export_onnx` (git-ignored); skipped if it isn't built.
const dir = resolve(__dirname, "../../../backend/ml/artifacts/smoke/onnx");
const available = existsSync(resolve(dir, "model_io.json"));
ort.env.wasm.numThreads = 1;

describe.skipIf(!available)("FormModel (onnxruntime-web, WebAssembly)", () => {
  const meta: FormModelMeta = available ? JSON.parse(readFileSync(resolve(dir, "model_meta.json"), "utf8")) : ({} as FormModelMeta);
  const io = available ? JSON.parse(readFileSync(resolve(dir, "model_io.json"), "utf8")) : { cases: [] };
  const bytes = (n: string) => (available ? new Uint8Array(readFileSync(resolve(dir, `form_model.${n}.onnx`))) : undefined);

  it.each(["int8", "fp32"] as const)("%s reproduces Python's probabilities", async (variant) => {
    const model = await FormModel.create(ort, { ...meta, default: variant }, { int8: bytes("int8"), fp32: bytes("fp32") });
    expect(model?.variant).toBe(variant);
    for (const c of io.cases) {
      const out = await model!.predictInput(Float32Array.from(c.x), c.ex);
      out.forEach((p, k) => expect(Math.abs(p - c[variant][k])).toBeLessThan(1e-4));
    }
  });

  it("falls back to fp32 when the int8 file is unusable", async () => {
    const model = await FormModel.create(ort, { ...meta, default: "int8" }, { int8: new Uint8Array([1, 2, 3]), fp32: bytes("fp32") });
    expect(model?.variant).toBe("fp32");
  });

  it("returns null rather than throwing when nothing loads", async () => {
    expect(await FormModel.create(ort, meta, { int8: new Uint8Array([9]) })).toBeNull();
  });

  it("scores a rep window: probabilities for that exercise's faults only", async () => {
    const model = (await FormModel.create(ort, meta, { int8: bytes("int8") }))!;
    const frames = 40;
    const window = { frames, joints: new Float64Array(frames * V * 3).fill(0.1), context: new Float64Array(frames * 3).fill(0.5) };
    const read = (await model.read("squat", window))!;
    expect(Object.keys(read.probs).sort()).toEqual(["chest_forward", "shallow_squat"]);
    expect(Object.values(read.probs).every((p) => p >= 0 && p <= 1)).toBe(true);
    expect(read.ms).toBeLessThan(250);
    expect(await model.read("not_an_exercise", window)).toBeNull();
  });
});
