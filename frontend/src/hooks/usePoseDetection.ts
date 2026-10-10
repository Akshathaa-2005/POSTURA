import { useEffect, useRef, useState, type RefObject } from "react";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import type { DetectionStatus } from "@/types";
import type { Landmark } from "@/types/mediapipe";

const WASM_PATH = "/mediapipe/wasm";
const MODEL_URL = process.env.NEXT_PUBLIC_POSE_MODEL_URL || "/mediapipe/models/pose_landmarker_lite.task";
// Used only if the self-hosted files are missing (e.g. `npm run setup:mediapipe` never ran).
const CDN_WASM_PATH = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const CDN_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export interface FrameInfo {
  width: number;
  height: number;
  now: number;
  fps: number;
}

export type PoseResultsHandler = (landmarks: Landmark[] | null, info: FrameInfo) => void;

// The landmarker is expensive to create (WASM + model), so share one across workouts.
let landmarkerPromise: Promise<PoseLandmarker> | null = null;

function getLandmarker(): Promise<PoseLandmarker> {
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
        const landmarker = await getLandmarker();
        if (cancelled) return;
        setStatus(pausedRef.current ? "paused" : "running");

        let lastVideoTime = -1;
        let lastFrameAt = performance.now();
        let fps = 0;

        const loop = () => {
          if (cancelled) return;
          raf = requestAnimationFrame(loop);
          if (pausedRef.current || video.readyState < 2 || video.currentTime === lastVideoTime) return;
          lastVideoTime = video.currentTime;

          const now = performance.now();
          let result;
          try {
            result = landmarker.detectForVideo(video, now);
          } catch (err) {
            // A single bad frame (e.g. during a resolution change) shouldn't end the workout.
            console.warn("Pose detection skipped a frame", err);
            return;
          }
          fps = fps ? fps * 0.9 + (1000 / Math.max(1, now - lastFrameAt)) * 0.1 : 30;
          lastFrameAt = now;

          onResultsRef.current(result.landmarks[0] ?? null, {
            width: video.videoWidth,
            height: video.videoHeight,
            now,
            fps,
          });
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
