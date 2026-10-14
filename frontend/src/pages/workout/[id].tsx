import { useEffect, useRef, useState } from "react";
import type { GetStaticPaths, GetStaticProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import AvatarCoach3D from "@/components/AvatarCoach3D";
import DashboardPanel from "@/components/DashboardPanel";
import Layout from "@/components/Layout";
import VideoPoseContainer from "@/components/VideoPoseContainer";
import WorkoutHUD from "@/components/WorkoutHUD";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import type { Exercise } from "@/types";
import type { Landmark } from "@/types/mediapipe";
import { getAvatarCommandForFault } from "@/utils/avatarCorrections";
import { EXERCISES, getExercise } from "@/utils/exercises";

export default function WorkoutPage({ exercise }: { exercise: Exercise }) {
  const [cameraOn, setCameraOn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const [mirrored, setMirrored] = useLocalStorage("aicoach.mirrored", true);
  const [showAngles, setShowAngles] = useLocalStorage("aicoach.showAngles", false);
  const [showAvatar, setShowAvatar] = useLocalStorage("aicoach.showAvatar", true);
  const router = useRouter();

  // Shared 60 FPS live pose landmarks ref connecting VideoPoseContainer to AvatarCoach3D
  const liveLandmarksRef = useRef<Landmark[] | null>(null);

  // Record mode is for collecting labelled reps to train the form model: open any workout with ?record=1.
  const [record, setRecord] = useLocalStorage("postura.record", false);
  useEffect(() => {
    if (router.query.record === "1") setRecord(true);
  }, [router.query.record, setRecord]);

  const status = useWorkoutState((s) => s.status);
  const reset = useWorkoutState((s) => s.reset);
  const issue = useWorkoutState((s) => s.issue);
  const coach = useWorkoutState((s) => s.coach);

  // Active command: prefer LLM-generated command from WebSocket, fall back to canonical biomechanical rule
  const activeCommand =
    coach.avatarCommand || (issue ? getAvatarCommandForFault(issue.id, issue.side) : null);

  const isSpeaking = Boolean(coach.voice && coach.correction && Date.now() - coach.correction.at < 5000);

  useEffect(() => {
    reset(exercise.id, exercise.rep_target);
  }, [exercise, sessionKey, reset]);

  const { sendRep, sendIssue, sendPraise } = useWebSocket({ exerciseId: exercise.id, active: cameraOn, sessionKey });

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
      {/* Top Header Bar */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-slate/10 pb-5">
        <div>
          <p className="eyebrow">
            {exercise.category}&nbsp;&nbsp;·&nbsp;&nbsp;{exercise.difficulty}&nbsp;&nbsp;·&nbsp;&nbsp;
            {exercise.mode === "hold" ? `${exercise.hold_target_sec} s hold` : `${exercise.rep_target} reps`}
          </p>
          <h1 className="mt-2 font-display text-5xl font-normal tracking-tight text-slate sm:text-6xl">{exercise.name}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Toggle active={mirrored} onClick={() => setMirrored((m) => !m)}>Mirror</Toggle>
          <Toggle active={showAngles} onClick={() => setShowAngles((v) => !v)}>Angles</Toggle>
          <Toggle active={showAvatar} onClick={() => setShowAvatar((v) => !v)}>50/50 Avatar</Toggle>
          {record && <Toggle active onClick={() => setRecord(false)}>Recording</Toggle>}
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

      {/* Main Practice Stage */}
      {showAvatar ? (
        /* Bounded 50/50 Dual Stage: Everything self-contained without scattering */
        <div className="space-y-6 max-w-[1440px] mx-auto">
          {/* Unified Bounded Telemetry & Guidance HUD */}
          <WorkoutHUD exercise={exercise} cameraOn={cameraOn} />

          {/* 50/50 Split View: Left = User Video Feed, Right = 3D Humanoid Avatar */}
          <section
            aria-label="Workout observation stage"
            className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-6 items-stretch w-full"
            style={{ minHeight: "560px" }}
          >
            {/* Left Column (50% on md+): User Video & Real-time Pose Skeleton */}
            <div className="flex flex-col h-full min-w-0">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="eyebrow flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${cameraOn ? "bg-good animate-pulse" : "bg-stone/40"}`} />
                  You · Video Feed
                </span>
                <span className="eyebrow !text-[11px] text-stone">
                  {exercise.view === "side" ? "Side Angle" : "Front Angle"}
                </span>
              </div>
              <div className="flex-1 h-full min-h-[380px]">
                <VideoPoseContainer
                  exercise={exercise}
                  cameraOn={cameraOn}
                  paused={paused}
                  mirrored={mirrored}
                  showAngles={showAngles}
                  sessionKey={sessionKey}
                  onStart={start}
                  onRepEvent={sendRep}
                  onCoachIssue={sendIssue}
                  onPraise={sendPraise}
                  liveLandmarksRef={liveLandmarksRef}
                />
              </div>
            </div>

            {/* Right Column (50% on md+): 3D Humanoid Avatar Coach */}
            <div className="flex flex-col h-full min-w-0">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="eyebrow flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-forest" />
                  Postura · 3D Humanoid Coach
                </span>
                <span className="eyebrow !text-[11px] text-stone truncate max-w-[200px]">
                  {activeCommand ? `Correcting: ${issue?.label || activeCommand.primary_fault}` : "Target Alignment"}
                </span>
              </div>
              <div className="card p-2 flex-1 flex flex-col h-full min-h-[380px] overflow-hidden">
                <AvatarCoach3D
                  command={activeCommand}
                  exerciseId={exercise.id}
                  defaultView={exercise.view === "side" ? "side" : "perspective"}
                  className="w-full h-full flex-1"
                  autoPlay
                  isSpeaking={isSpeaking}
                  liveLandmarksRef={liveLandmarksRef}
                  cameraOn={cameraOn && !paused}
                  mirrored={mirrored}
                />
              </div>
            </div>
          </section>

          {/* Form Criteria & Exercise Notes (Cleanly Bounded Below) */}
          <section className="card p-5 border border-slate/10 bg-sand/30">
            <h2 className="eyebrow">Exercise Guidance</h2>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {exercise.correction_tips.map((tip, i) => (
                <div key={tip} className="rounded-xl bg-paper p-3 text-xs leading-relaxed text-ink shadow-xs">
                  <span className="font-display text-sm font-medium text-taupe mr-1.5">{String(i + 1).padStart(2, "0")}</span>
                  {tip}
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : (
        /* Single View Stage: Traditional Sidebar Layout */
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(320px,3fr)]">
          <VideoPoseContainer
            exercise={exercise}
            cameraOn={cameraOn}
            paused={paused}
            mirrored={mirrored}
            showAngles={showAngles}
            sessionKey={sessionKey}
            onStart={start}
            onRepEvent={sendRep}
            onCoachIssue={sendIssue}
            onPraise={sendPraise}
            liveLandmarksRef={liveLandmarksRef}
          />
          <DashboardPanel exercise={exercise} mirrored={mirrored} record={record} showAvatar={false} />
        </div>
      )}
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
