import type { InferenceSession, Tensor } from "onnxruntime-web/wasm";
import type { RepWindow } from "@/types";
import { MODEL_CHANNELS, SPEC, T, V, resample, toModelInput } from "./skeleton";

const BASE = "/models/form";
const WASM_PATH = "/ort/";

export interface FormModelMeta {
  spec_version: number;
  window: number;
  channels: number;
  exercises: string[];
  faults: string[];
  threshold: number;
  synthetic: boolean;
  default?: "int8" | "fp32";
}

export interface ModelRead {
  /** Probability of each of this exercise's faults, keyed by fault id (without the exercise prefix). */
  probs: Record<string, number>;
  /** Faults at or above the model's threshold, most likely first. */
  faults: { id: string; prob: number }[];
  ms: number;
}

type Ort = typeof import("onnxruntime-web/wasm");

/** Scores one rep's skeleton with the exported ST-GCN. Advisory: it never decides whether a rep counts. */
export class FormModel {
  private constructor(
    private readonly ort: Ort,
    private readonly session: InferenceSession,
    readonly meta: FormModelMeta,
    readonly variant: "int8" | "fp32",
  ) {}

  static async create(ort: Ort, meta: FormModelMeta, files: { int8?: ArrayBuffer | Uint8Array; fp32?: ArrayBuffer | Uint8Array }) {
    const order = meta.default === "fp32" ? (["fp32", "int8"] as const) : (["int8", "fp32"] as const);
    for (const variant of order) {
      const bytes = files[variant];
      if (!bytes) continue;
      try {
        const session = await ort.InferenceSession.create(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
        const model = new FormModel(ort, session, meta, variant);
        await model.predictInput(new Float32Array(MODEL_CHANNELS * T * V), 0); // warm up the runtime
        return model;
      } catch (err) {
        console.warn(`[form model] ${variant} failed to load`, err);
      }
    }
    return null;
  }

  async predictInput(x: Float32Array, exerciseIndex: number): Promise<Float32Array> {
    const feeds = {
      x: new this.ort.Tensor("float32", x, [1, MODEL_CHANNELS, T, V]) as Tensor,
      ex: new this.ort.Tensor("int64", BigInt64Array.from([BigInt(exerciseIndex)]), [1]) as Tensor,
    };
    return (await this.session.run(feeds)).probs.data as Float32Array;
  }

  async read(exerciseId: string, window: RepWindow): Promise<ModelRead | null> {
    const ex = this.meta.exercises.indexOf(exerciseId);
    if (ex < 0) return null;
    const t0 = performance.now();
    const joints = resample(window.joints, window.frames, V * 3, T);
    const context = resample(window.context, window.frames, SPEC.context_dim, T);
    const out = await this.predictInput(toModelInput(joints, context), ex);
    const probs: Record<string, number> = {};
    const prefix = `${exerciseId}:`;
    this.meta.faults.forEach((name, k) => {
      if (name.startsWith(prefix)) probs[name.slice(prefix.length)] = out[k];
    });
    const faults = Object.entries(probs)
      .filter(([, p]) => p >= this.meta.threshold)
      .sort((a, b) => b[1] - a[1])
      .map(([id, prob]) => ({ id, prob }));
    return { probs, faults, ms: performance.now() - t0 };
  }
}

let loading: Promise<FormModel | null> | null = null;

/** Loads the model from /models/form if one has been placed there; resolves null (never throws) if not. */
export function loadFormModel(): Promise<FormModel | null> {
  loading ??= (async () => {
    try {
      const metaRes = await fetch(`${BASE}/model_meta.json`);
      if (!metaRes.ok) return null;
      const meta: FormModelMeta = await metaRes.json();
      if (meta.spec_version !== SPEC.version) {
        console.warn("[form model] skipped: it was trained on a different skeleton spec");
        return null;
      }
      if (meta.synthetic && process.env.NODE_ENV === "production") {
        console.warn("[form model] skipped: this model was trained on synthetic data");
        return null;
      }
      const ort = await import("onnxruntime-web/wasm");
      ort.env.wasm.wasmPaths = WASM_PATH;
      ort.env.wasm.numThreads = 1; // the app isn't cross-origin isolated, so threads aren't available
      const get = (name: string) => fetch(`${BASE}/form_model.${name}.onnx`).then((r) => (r.ok ? r.arrayBuffer() : undefined), () => undefined);
      const [int8, fp32] = await Promise.all([get("int8"), get("fp32")]);
      return await FormModel.create(ort, meta, { int8, fp32 });
    } catch (err) {
      console.warn("[form model] unavailable", err);
      return null;
    }
  })();
  return loading;
}
