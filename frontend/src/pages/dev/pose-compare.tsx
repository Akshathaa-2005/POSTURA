import { useCallback, useEffect, useRef, useState } from "react";
import { getLandmarker } from "@/hooks/usePoseDetection";
import { COCO_TO_LM, cocoToLandmarks } from "@/pose/cocoAdapter";
import { compareSources, type CompareFrame, type CompareReport } from "@/pose/poseCompare";
import { YoloPoseDetector } from "@/pose/yoloPose";
import type { Landmark } from "@/types/mediapipe";

/**
 * Dev-only harness: runs MediaPipe and YOLO-pose over the same recorded clip, frame by frame, and reports how they
 * differ (see pose/poseCompare.ts). Frames are *seeked*, not played, so both models see every sampled frame and the
 * latency figures time only the model call. Model-only latency: it excludes the camera and rendering.
 */

const BODY_LM: number[] = [...COCO_TO_LM].slice(5);
const pct = (v: number | null) => (v === null || Number.isNaN(v) ? "–" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null, d = 1) => (v === null || Number.isNaN(v) ? "–" : v.toFixed(d));

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-3) return resolve();
    const done = () => {
      video.removeEventListener("seeked", done);
      requestAnimationFrame(() => resolve());
    };
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

function drawPose(ctx: CanvasRenderingContext2D, lm: Landmark[] | null, color: string, w: number, h: number) {
  if (!lm) return;
  ctx.fillStyle = color;
  for (const i of BODY_LM) {
    const p = lm[i];
    if (p.visibility < 0.5) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function PoseCompare() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [sampleFps, setSampleFps] = useState(30);
  const [forceWasm, setForceWasm] = useState(false);
  const [status, setStatus] = useState("Pick a clip (ideally a full-body workout recording).");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<CompareReport | null>(null);
  const [provider, setProvider] = useState<string>("");
  const cancel = useRef(false);

  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const run = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || !video.duration) return;
    cancel.current = false;
    setRunning(true);
    setReport(null);
    try {
      setStatus("Loading models…");
      const [landmarker, yolo] = await Promise.all([getLandmarker(), YoloPoseDetector.create({ forceWasm })]);
      setProvider(yolo.provider);
      const w = video.videoWidth;
      const h = video.videoHeight;
      overlay.width = w;
      overlay.height = h;
      const ctx = overlay.getContext("2d")!;
      const frames: CompareFrame[] = [];
      const total = Math.floor(video.duration * sampleFps);

      for (let n = 0; n < total && !cancel.current; n++) {
        const t = n / sampleFps;
        await seek(video, t);

        const a0 = performance.now();
        const a = landmarker.detectForVideo(video, Math.round(t * 1000) + 1).landmarks[0] ?? null;
        const aMs = performance.now() - a0;

        const b0 = performance.now();
        const det = await yolo.detect(video);
        const bMs = performance.now() - b0;
        const b = det ? cocoToLandmarks(det.keypoints, { aspect: w / h }) : null;

        frames.push({ t, width: w, height: h, a, b, aMs, bMs });
        ctx.clearRect(0, 0, w, h);
        drawPose(ctx, a, "#22c55e", w, h); // MediaPipe: green
        drawPose(ctx, b, "#f97316", w, h); // YOLO: orange
        if (n % 5 === 0) setStatus(`Frame ${n + 1} / ${total}`);
      }
      setReport(compareSources(frames));
      setStatus(cancel.current ? "Stopped early." : "Done.");
    } catch (err) {
      console.error(err);
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [sampleFps, forceWasm]);

  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href: url, download: "pose-compare.json" }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 text-sm">
      <h1 className="text-xl font-semibold">Pose compare: MediaPipe vs YOLO</h1>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept="video/*"
          disabled={running}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) { setSrc(URL.createObjectURL(f)); setReport(null); setStatus("Ready."); }
          }}
        />
        <label>Sample fps <input type="number" min={5} max={60} value={sampleFps} disabled={running} onChange={(e) => setSampleFps(Number(e.target.value) || 30)} className="w-16 border px-1" /></label>
        <label><input type="checkbox" checked={forceWasm} disabled={running} onChange={(e) => setForceWasm(e.target.checked)} /> YOLO on WASM (skip WebGPU)</label>
        <button className="rounded border px-3 py-1" disabled={!src || running} onClick={run}>Run</button>
        {running && <button className="rounded border px-3 py-1" onClick={() => (cancel.current = true)}>Stop</button>}
        {report && <button className="rounded border px-3 py-1" onClick={download}>Download JSON</button>}
      </div>
      <p>{status}{provider && ` · YOLO provider: ${provider}`}</p>

      {src && (
        <div className="relative inline-block max-w-full">
          <video ref={videoRef} src={src} muted playsInline preload="auto" className="max-h-[420px] max-w-full" />
          <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
          <p className="mt-1 text-xs"><span className="text-green-600">● MediaPipe</span> <span className="text-orange-500">● YOLO</span></p>
        </div>
      )}

      {report && (
        <>
          <p>
            {report.frames} frames · no person: MediaPipe {report.noPoseA}, YOLO {report.noPoseB} · torso ≈ {num(report.torsoPx, 0)} px ·
            latency p50/p95 ms: MediaPipe {num(report.latency.a.p50)}/{num(report.latency.a.p95)}, YOLO {num(report.latency.b.p50)}/{num(report.latency.b.p95)}
          </p>
          <table className="w-full border-collapse text-left">
            <thead><tr className="border-b"><th>Joint</th><th>Dropout MP</th><th>Dropout YOLO</th><th>Disagree mean</th><th>Disagree p95</th><th>Jitter MP</th><th>Jitter YOLO</th></tr></thead>
            <tbody>
              {report.joints.map((j) => (
                <tr key={j.name} className="border-b">
                  <td>{j.name}</td><td>{pct(j.dropoutA)}</td><td>{pct(j.dropoutB)}</td>
                  <td>{pct(j.disagreementMean)}</td><td>{pct(j.disagreementP95)}</td>
                  <td>{num(j.jitterA, 3)}</td><td>{num(j.jitterB, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="w-full border-collapse text-left">
            <thead><tr className="border-b"><th>Joint angle</th><th>Samples</th><th>Mean |Δ|°</th><th>p95 |Δ|°</th></tr></thead>
            <tbody>
              {report.angles.map((a) => (
                <tr key={a.name} className="border-b"><td>{a.name}</td><td>{a.samples}</td><td>{num(a.meanAbsDiffDeg)}</td><td>{num(a.p95AbsDiffDeg)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs opacity-70">
            Disagreement is a fraction of torso length, not error: neither model is ground truth. A joint counts as missing below 0.5
            visibility (MediaPipe) / score (YOLO), and those are not calibrated alike. Jitter is unitless; compare columns only.
          </p>
        </>
      )}
    </main>
  );
}

export default function PoseComparePage() {
  if (process.env.NODE_ENV === "production") return <p className="p-4">Not available in production builds.</p>;
  return <PoseCompare />;
}
