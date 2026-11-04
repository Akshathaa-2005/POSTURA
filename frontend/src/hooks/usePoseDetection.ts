import { useEffect, useRef, useState, type RefObject } from "react";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import type { DetectionStatus } from "@/types";
import type { Landmark } from "@/types/mediapipe";
import { cocoToLandmarks } from "@/pose/cocoAdapter";
import type { YoloPoseDetector } from "@/pose/yoloPose";

const WASM_PATH = "/mediapipe/wasm";
// lite | full | heavy. "full" holds up much better than "lite" when limbs are partly hidden; "heavy" is for fast GPUs.
const VARIANT = process.env.NEXT_PUBLIC_POSE_MODEL_VARIANT || "full";
const MODEL_URL = process.env.NEXT_PUBLIC_POSE_MODEL_URL || `/mediapipe/models/pose_landmarker_${VARIANT}.task`;
// Used only if the self-hosted files are missing (e.g. `npm run setup:mediapipe` never ran).
const CDN_WASM_PATH = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const CDN_MODEL_URL = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${VARIANT}/float16/1/pose_landmarker_${VARIANT}.task`;

/**
 * Which pose model drives the app: "mediapipe" (default) or "yolo" (experimental YOLO11-pose via onnxruntime-web;
 * needs public/models/yolo/yolo11s-pose.onnx). Set NEXT_PUBLIC_POSE_BACKEND, or add `?pose=yolo` to the URL to
 * try it for one session.
 */
export type PoseBackend = "mediapipe" | "yolo";

function chooseBackend(): PoseBackend {
  const fromUrl = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("pose") : null;
  const wanted = fromUrl || process.env.NEXT_PUBLIC_POSE_BACKEND;
  return wanted === "yolo" ? "yolo" : "mediapipe";
}

export interface FrameInfo {
  width: number;
  height: number;
  now: number;
  fps: number;
}

export type PoseResultsHandler = (landmarks: Landmark[] | null, info: FrameInfo) => void;

// The landmarker is expensive to create (WASM + model), so share one across workouts.
let landmarkerPromise: Promise<PoseLandmarker> | null = null;

export function getLandmarker(): Promise<PoseLandmarker> {
  landmarkerPromise ??= (async () => {
    const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
    const selfHosted = await fetch(MODEL_URL, { method: "HEAD" }).then((r) => r.ok, () => false);
    if (!selfHosted) console.warn("Self-hosted pose model not found; loading MediaPipe from the CDN");
    const vision = await FilesetResolver.forVisionTasks(selfHosted ? WASM_PATH : CDN_WASM_PATH);
    const modelAssetPath = selfHosted ? MODEL_URL : CDN_MODEL_URL;
    const create = (delegate: "GPU" | "CPU") =>
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      return await create("GPU");
    } catch (err) {
      console.warn("GPU delegate unavailable, falling back to CPU", err);
      return create("CPU");
    }
  })().catch((err) => {
    landmarkerPromise = null; // allow retry
    throw err;
  });
  return landmarkerPromise;
}

let yoloPromise: Promise<YoloPoseDetector> | null = null;

function getYolo(): Promise<YoloPoseDetector> {
  yoloPromise ??= import("@/pose/yoloPose")
    .then(({ YoloPoseDetector }) => YoloPoseDetector.create())
    .catch((err) => {
      yoloPromise = null; // allow retry
      throw err;
    });
  return yoloPromise;
}

/** One frame in, 33 MediaPipe-layout landmarks (or null) out, whichever model is running. */
type Detect = (video: HTMLVideoElement, now: number) => Landmark[] | null | Promise<Landmark[] | null>;

async function createDetector(backend: PoseBackend): Promise<Detect> {
  if (backend === "yolo") {
    const yolo = await getYolo();
    console.info(`[pose] YOLO11-pose on ${yolo.provider}`);
    return async (video) => {
      const det = await yolo.detect(video);
      return det ? cocoToLandmarks(det.keypoints, { aspect: video.videoWidth / video.videoHeight }) : null;
    };
  }
  const landmarker = await getLandmarker();
  return (video, now) => landmarker.detectForVideo(video, now).landmarks[0] ?? null;
}

function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "Camera permission was denied. Allow camera access in your browser and try again.";
    if (err.name === "NotFoundError") return "No camera was found on this device.";
    if (err.name === "NotReadableError") return "The camera is already in use by another application.";
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Camera access requires HTTPS or localhost.";
  }
  return err instanceof Error ? err.message : "Something went wrong starting pose detection.";
}

/**
 * Streams the webcam into `videoRef` and runs MediaPipe pose detection in the browser
 * on every new video frame, calling `onResults` with the first detected pose.
 */
export function usePoseDetection(
  videoRef: RefObject<HTMLVideoElement>,
  { enabled, paused, onResults }: { enabled: boolean; paused: boolean; onResults: PoseResultsHandler },
) {
  const [status, setStatus] = useState<DetectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const onResultsRef = useRef(onResults);
  onResultsRef.current = onResults;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    setStatus((s) => (s === "running" || s === "paused" ? (paused ? "paused" : "running") : s));
  }, [paused]);

  useEffect(() => {
    const video = videoRef.current;
    if (!enabled || !video) {
      setStatus("idle");
      return;
    }

    const backend = chooseBackend();
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;

    (async () => {
      try {
        setError(null);
        setStatus("starting-camera");
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) return;
        // Unplugged webcam, revoked permission, or another app grabbing the camera.
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (cancelled) return;
          setError("The camera disconnected. Check it's plugged in and not in use, then try again.");
          setStatus("error");
        });
        video.srcObject = stream;
        await video.play();

        setStatus("loading-model");
        const detect = await createDetector(backend);
        if (cancelled) return;
        setStatus(pausedRef.current ? "paused" : "running");

        let lastVideoTime = -1;
        let lastFrameAt = performance.now();
        let fps = 0;
        // The YOLO path is async; while a frame is in flight newer frames are skipped rather than queued.
        let busy = false;

        const loop = () => {
          if (cancelled) return;
          raf = requestAnimationFrame(loop);
          if (busy || pausedRef.current || video.readyState < 2 || video.currentTime === lastVideoTime) return;
          lastVideoTime = video.currentTime;

          const emit = (landmarks: Landmark[] | null) => {
            const now = performance.now();
            fps = fps ? fps * 0.9 + (1000 / Math.max(1, now - lastFrameAt)) * 0.1 : 30;
            lastFrameAt = now;
            onResultsRef.current(landmarks, { width: video.videoWidth, height: video.videoHeight, now, fps });
          };

          let result;
          try {
            result = detect(video, performance.now());
          } catch (err) {
            // A single bad frame (e.g. during a resolution change) shouldn't end the workout.
            console.warn("Pose detection skipped a frame", err);
            return;
          }
          if (!(result instanceof Promise)) return emit(result);
          busy = true;
          result
            .then((landmarks) => {
              if (!cancelled && !pausedRef.current) emit(landmarks);
            })
            .catch((err) => console.warn("Pose detection skipped a frame", err))
            .finally(() => (busy = false));
        };
        loop();
      } catch (err) {
        if (cancelled) return;
        console.error(err);
        setError(describeError(err));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }, [enabled, videoRef]);

  return { status, error };
}
