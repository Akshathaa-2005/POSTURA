import { useEffect, useState } from "react";
import type { GetStaticPaths, GetStaticProps } from "next";
import Link from "next/link";
import DashboardPanel from "@/components/DashboardPanel";
import Layout from "@/components/Layout";
import VideoPoseContainer from "@/components/VideoPoseContainer";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import type { Exercise } from "@/types";
import { EXERCISES, getExercise } from "@/utils/exercises";

export default function WorkoutPage({ exercise }: { exercise: Exercise }) {
  const [cameraOn, setCameraOn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const [mirrored, setMirrored] = useLocalStorage("aicoach.mirrored", true);
  const [showAngles, setShowAngles] = useLocalStorage("aicoach.showAngles", false);
  const status = useWorkoutState((s) => s.status);
  const reset = useWorkoutState((s) => s.reset);

  useEffect(() => {
    reset(exercise.id, exercise.rep_target);
  }, [exercise, sessionKey, reset]);

  const start = () => {
    setPaused(false);
    // Toggle off/on so "Try again" re-requests the camera after an error.
    setCameraOn(false);
    requestAnimationFrame(() => setCameraOn(true));
  };
  const live = status === "running" || status === "paused";

  return (
    <Layout
      title={exercise.name}
      actions={
        <Link href="/" className="eyebrow transition hover:text-ink">
          ← All movements
        </Link>
      }
    >
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-slate/10 pb-5">
        <div>
          <p className="eyebrow">
            {exercise.category}&nbsp;&nbsp;·&nbsp;&nbsp;{exercise.difficulty}&nbsp;&nbsp;·&nbsp;&nbsp;{exercise.rep_target} reps
          </p>
          <h1 className="mt-2 font-display text-5xl font-normal tracking-tight text-slate sm:text-6xl">{exercise.name}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Toggle active={mirrored} onClick={() => setMirrored((m) => !m)}>Mirror</Toggle>
          <Toggle active={showAngles} onClick={() => setShowAngles((v) => !v)}>Angles</Toggle>
          <ControlButton disabled={!live} onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </ControlButton>
          <ControlButton disabled={!live} onClick={() => setSessionKey((k) => k + 1)}>Reset</ControlButton>
          {cameraOn && (
            <ControlButton onClick={() => setCameraOn(false)} danger>
              Stop camera
            </ControlButton>
          )}
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(320px,3fr)]">
        <VideoPoseContainer
          exercise={exercise}
          cameraOn={cameraOn}
          paused={paused}
          mirrored={mirrored}
          showAngles={showAngles}
          sessionKey={sessionKey}
          onStart={start}
        />
        <DashboardPanel exercise={exercise} />
      </div>
    </Layout>
  );
}

function ControlButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`pill ${danger ? "border-bad/30 text-bad hover:bg-bad/5" : "border-slate/15 bg-linen text-ink hover:border-slate/30"}`}
    >
      {children}
    </button>
  );
}

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`pill ${active ? "border-slate bg-slate text-linen" : "border-slate/15 text-stone hover:text-ink"}`}
    >
      {children}
    </button>
  );
}

export const getStaticPaths: GetStaticPaths = () => ({
  paths: EXERCISES.map((e) => ({ params: { id: e.id } })),
  fallback: false,
});

export const getStaticProps: GetStaticProps<{ exercise: Exercise }, { id: string }> = ({ params }) => {
  const exercise = params && getExercise(params.id);
  return exercise ? { props: { exercise } } : { notFound: true };
};
