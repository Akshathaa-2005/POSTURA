import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Exercise, RepEvent } from "@/types";
import { usePoseDetection, type PoseResultsHandler } from "@/hooks/usePoseDetection";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import { WorkoutEngine } from "@/utils/workoutEngine";
import PoseFigure from "./PoseFigure";
import PoseSkeleton, { type SkeletonFrame } from "./PoseSkeleton";

interface Props {
  exercise: Exercise;
  cameraOn: boolean;
  paused: boolean;
  mirrored: boolean;
  showAngles: boolean;
  /** Changing this restarts rep counting and scoring. */
  sessionKey: number;
  onStart: () => void;
}

/** How often (ms) the React dashboard is refreshed; the canvas updates every frame regardless. */
const UI_UPDATE_MS = 100;

export default function VideoPoseContainer({
  exercise,
  cameraOn,
  paused,
  mirrored,
  showAngles,
  sessionKey,
  onStart,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });
  const frameRef = useRef<SkeletonFrame>({ landmarks: null, jointStatus: new Map(), angles: {}, updatedAt: 0 });

  const engine = useMemo(() => new WorkoutEngine(exercise), [exercise, sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastPush = useRef(0);
  const lastFrameAt = useRef<number | null>(null);
  const unpushedMs = useRef(0);
  const pendingEvent = useRef<RepEvent | null>(null);

  const { applySnapshot, setStatus } = useWorkoutState.getState();
  const personVisible = useWorkoutState((s) => s.personVisible);
  const inFrame = useWorkoutState((s) => s.inFrame);
  const lastEvent = useWorkoutState((s) => s.lastEvent);

  const onResults = useCallback<PoseResultsHandler>(
    (landmarks, { width, height, now, fps }) => {
      if (width !== dims.width || height !== dims.height) setDims({ width, height });

      const snap = engine.process(landmarks, width, height, now);
      frameRef.current = {
        landmarks: snap.landmarks,
        jointStatus: snap.jointStatus,
        angles: snap.angles,
        updatedAt: now,
      };
      if (snap.repEvent) pendingEvent.current = snap.repEvent;

      // Count active time only while frames are flowing (pauses are excluded).
      if (lastFrameAt.current !== null) unpushedMs.current += Math.min(250, now - lastFrameAt.current);
      lastFrameAt.current = now;

      if (now - lastPush.current >= UI_UPDATE_MS || pendingEvent.current) {
        applySnapshot(snap, { fps, dtMs: unpushedMs.current, event: pendingEvent.current });
        lastPush.current = now;
        unpushedMs.current = 0;
        pendingEvent.current = null;
      }
    },
    [engine, dims.width, dims.height, applySnapshot],
  );

  const { status, error } = usePoseDetection(videoRef, { enabled: cameraOn, paused, onResults });

  useEffect(() => setStatus(status, error), [status, error, setStatus]);

  // Don't count time across a pause as active workout time.
  useEffect(() => {
    lastFrameAt.current = null;
  }, [paused, cameraOn]);

  // Dismiss the rep pop shortly after it appears.
  useEffect(() => {
    if (!lastEvent) return;
    const id = setTimeout(() => {
      if (useWorkoutState.getState().lastEvent === lastEvent) useWorkoutState.setState({ lastEvent: null });
    }, 1000);
    return () => clearTimeout(id);
  }, [lastEvent]);

  const loading = status === "starting-camera" || status === "loading-model";

  return (
    <div className="card p-2">
      <div
        className={`relative aspect-video w-full overflow-hidden rounded-[16px] transition-colors duration-500 ${
          status === "running" || status === "paused" ? "bg-slate" : "bg-paper"
        }`}
      >
        <div className={`absolute inset-0 ${mirrored ? "-scale-x-100" : ""}`}>
          <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-contain" />
          <PoseSkeleton
            frameRef={frameRef}
            width={dims.width}
            height={dims.height}
            mirrored={mirrored}
            showAngles={showAngles}
          />
        </div>

        {/* Status overlays */}
        {status === "idle" && (
          <Overlay>
            <div className="grid w-full max-w-3xl items-center gap-6 sm:grid-cols-[1fr_1.2fr]">
              <div className="mx-auto aspect-[3/4] w-32 rounded-[14px] bg-mist sm:w-full sm:max-w-[220px]">
                <PoseFigure exerciseId={exercise.id} className="h-full w-full p-4" />
              </div>
              <div className="text-center sm:text-left">
                <p className="eyebrow">Camera setup</p>
                <p className="mt-3 font-display text-2xl leading-snug text-slate sm:text-3xl">{exercise.camera_setup}.</p>
                <p className="mt-2 text-sm font-light text-stone">Follow the figure’s rhythm once you’re in frame.</p>
                <button
                  onClick={onStart}
                  className="mt-6 rounded-full bg-slate px-8 py-3 text-sm font-medium tracking-wide text-linen transition hover:bg-ink active:scale-95"
                >
                  Start camera
                </button>
                <p className="eyebrow mt-4 !text-[10px]">Video never leaves your device</p>
              </div>
            </div>
          </Overlay>
        )}
        {loading && (
          <Overlay>
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-dusty border-t-slate" />
            <p className="eyebrow mt-5">{status === "starting-camera" ? "Starting camera" : "Loading pose model"}</p>
          </Overlay>
        )}
        {status === "error" && (
          <Overlay>
            <p className="max-w-sm text-center font-display text-2xl text-bad">{error}</p>
            <button onClick={onStart} className="pill mt-5 border-slate/20 text-ink hover:bg-slate/5">
              Try again
            </button>
          </Overlay>
        )}
        {status === "paused" && (
          <Overlay translucent>
            <p className="font-display text-4xl italic text-slate">Paused</p>
            <p className="eyebrow mt-2">Take a breath</p>
          </Overlay>
        )}

        {status === "running" && (!personVisible || !inFrame) && (
          <div className="absolute inset-x-0 top-4 flex justify-center px-4">
            <div className="rounded-full bg-linen/90 px-5 py-2 text-sm text-ink shadow-soft backdrop-blur">
              {personVisible ? `Adjust position: ${exercise.camera_setup.toLowerCase()}` : "Step into the frame"}
            </div>
          </div>
        )}

        {/* Rep feedback pop */}
        <AnimatePresence>
          {lastEvent && status === "running" && (
            <motion.div
              key={lastEvent.at}
              initial={{ opacity: 0, scale: 0.7, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, y: -30 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2"
            >
              {lastEvent.type === "rep" ? (
                <span className="flex h-20 w-20 items-center justify-center rounded-full bg-linen/90 font-display text-4xl text-done shadow-soft backdrop-blur">
                  +1
                </span>
              ) : (
                <span className="whitespace-nowrap rounded-full bg-linen/90 px-5 py-2 text-sm text-warn shadow-soft backdrop-blur">
                  Partial rep ({lastEvent.rom}%) · go through the full range
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Overlay({ children, translucent }: { children: React.ReactNode; translucent?: boolean }) {
  return (
    <div
      className={`absolute inset-0 flex flex-col items-center justify-center p-6 ${
        translucent ? "bg-paper/60 backdrop-blur-sm" : "bg-paper"
      }`}
    >
      {children}
    </div>
  );
}
