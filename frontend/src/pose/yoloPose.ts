import type { InferenceSession } from "onnxruntime-web/webgpu";
import { decodePose, letterbox, OUTPUT_CHANNELS, type DecodeOptions, type YoloDetection } from "./yoloDecode";

/**
 * Browser YOLO-pose detector on onnxruntime-web (WebGPU, falling back to WASM). Not wired into
 * `usePoseDetection` yet: use it through `/dev/pose-compare` until it has been compared against MediaPipe.
 * Export the model with: `yolo export model=yolo11s-pose.pt format=onnx imgsz=640 opset=17 simplify=True`
 * and place it at `public/models/yolo/yolo11s-pose.onnx` (or set NEXT_PUBLIC_YOLO_MODEL_URL).
 */

const MODEL_URL = process.env.NEXT_PUBLIC_YOLO_MODEL_URL || "/models/yolo/yolo11s-pose.onnx";
const WASM_PATH = "/ort/";

type Ort = typeof import("onnxruntime-web/webgpu");
export type YoloProvider = "webgpu" | "wasm";
export type YoloSource = HTMLVideoElement | HTMLCanvasElement;

export interface YoloOptions extends DecodeOptions {
  modelUrl?: string;
  /** Square network input. Must match the size the model was exported at. */
  size?: number;
  /** Skip WebGPU and run on WASM. */
  forceWasm?: boolean;
}

const dims = (s: YoloSource) => (s instanceof HTMLVideoElement ? [s.videoWidth, s.videoHeight] : [s.width, s.height]);

export class YoloPoseDetector {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly input: Float32Array;

  private constructor(
    private readonly ort: Ort,
    private readonly session: InferenceSession,
    readonly provider: YoloProvider,
    private readonly size: number,
    private readonly decode: DecodeOptions,
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    this.input = new Float32Array(3 * size * size);
  }

  static async create(opts: YoloOptions = {}): Promise<YoloPoseDetector> {
    const { modelUrl = MODEL_URL, size = 640, forceWasm, ...decode } = opts;
    const res = await fetch(modelUrl);
    if (!res.ok) throw new Error(`YOLO model not found at ${modelUrl} (HTTP ${res.status}). See the export command in pose/yoloPose.ts.`);
    const bytes = new Uint8Array(await res.arrayBuffer());

    const ort = await import("onnxruntime-web/webgpu");
    ort.env.wasm.wasmPaths = WASM_PATH;
    ort.env.wasm.numThreads = 1; // the app isn't cross-origin isolated, so threads aren't available

    const providers: YoloProvider[] = forceWasm || !("gpu" in navigator) ? ["wasm"] : ["webgpu", "wasm"];
    let lastErr: unknown;
    for (const provider of providers) {
      try {
        const session = await ort.InferenceSession.create(bytes, { executionProviders: [provider], graphOptimizationLevel: "all" });
        const detector = new YoloPoseDetector(ort, session, provider, size, decode);
        await detector.detect(detector.ctx.canvas); // warm up: first run compiles shaders / allocates
        return detector;
      } catch (err) {
        lastErr = err;
        console.warn(`[yolo] ${provider} failed to start`, err);
      }
    }
    throw lastErr;
  }

  /** The best person in the frame, or null. Keypoints are normalised to the source frame. */
  async detect(source: YoloSource): Promise<YoloDetection | null> {
    const [w, h] = dims(source);
    if (!w || !h) return null;
    const lb = letterbox(w, h, this.size);
    const { size, ctx, input } = this;

    ctx.fillStyle = "rgb(114,114,114)";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(source, lb.padX, lb.padY, w * lb.scale, h * lb.scale);
    const px = ctx.getImageData(0, 0, size, size).data;

    const plane = size * size;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      input[i] = px[p] / 255;
      input[plane + i] = px[p + 1] / 255;
      input[2 * plane + i] = px[p + 2] / 255;
    }

    const feeds = { [this.session.inputNames[0]]: new this.ort.Tensor("float32", input, [1, 3, size, size]) };
    const out = (await this.session.run(feeds))[this.session.outputNames[0]];
    if (out.dims.length !== 3 || out.dims[1] !== OUTPUT_CHANNELS) {
      throw new Error(`Unexpected YOLO output shape [${out.dims.join(", ")}]; expected [1, ${OUTPUT_CHANNELS}, N]`);
    }
    return decodePose(out.data as Float32Array, out.dims[2], lb, this.decode)[0] ?? null;
  }
}

