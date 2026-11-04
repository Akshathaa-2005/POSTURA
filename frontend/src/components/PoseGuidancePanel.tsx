import { useEffect, useRef, useState } from "react";
import { useSpeech } from "@/hooks/useSpeech";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import type { Exercise } from "@/types";
import { GUIDANCE_INTERVAL_MS, guidanceFor, SpeechPacer, targetAngles, type GuidanceResult } from "@/utils/poseGuidance";
import { unlockBrowserSpeech } from "@/utils/speech";

interface Props {
  exercise: Exercise;
  voiceOn: boolean;
  onVoiceToggle: () => void;
}

/**
 * Pose-guidance mode: compares the user's joint angles with the exercise's target pose about once
 * a second and says which joint to move, which way and by roughly how many degrees.
 * Everything runs in the browser; the text is always shown, speech is a bonus.
 */
export default function PoseGuidancePanel({ exercise, voiceOn, onVoiceToggle }: Props) {
  const [result, setResult] = useState<GuidanceResult | null>(null);
  const pacer = useRef(new SpeechPacer());
  const { status, lastError, queue } = useSpeech();
  const hasTarget = targetAngles(exercise.id) !== null;
  const tracking = useWorkoutState((s) => s.status === "running");

  useEffect(() => {
    pacer.current.reset();
    setResult(null);
    if (!hasTarget) return;
    const id = window.setInterval(() => {
      const { angles, sides, status: st } = useWorkoutState.getState();
      if (st !== "running") return setResult(null);
      const next = guidanceFor(exercise, angles, sides);
      setResult(next);
      if (!next) return;
      const sentence = pacer.current.next(next, performance.now());
      if (sentence && voiceOn) queue.enqueue({ text: sentence });
    }, GUIDANCE_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      queue.cancel();
    };
  }, [exercise, hasTarget, voiceOn, queue]);

  const audioDown = voiceOn && status === "unavailable";
  const headline = !hasTarget
    ? "No target pose is defined for this movement."
    : !tracking
      ? "Start the camera to get live guidance."
      : !result || result.compared === 0
        ? "Step into frame so your joints are visible."
        : result.inPosition
          ? "In position. Hold it."
          : result.instructions[0].text;

  return (
    <section aria-label="Pose guidance" className="card border border-slate/10 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="eyebrow">Pose Guidance · target: {exercise.name} peak</h2>
          <p className="mt-0.5 text-xs text-stone">Updates every {(GUIDANCE_INTERVAL_MS / 1000).toFixed(2)} s</p>
        </div>
        <button
          onClick={() => {
            if (!voiceOn) unlockBrowserSpeech(); // must happen inside the click for browsers to allow speech
            onVoiceToggle();
          }}
          aria-pressed={voiceOn}
          className={`pill !px-3 !py-1 text-xs ${voiceOn ? "border-slate bg-slate text-linen" : "border-slate/15 text-stone"}`}
        >
          {voiceOn ? (status === "speaking" ? "Speaking…" : "Voice on") : "Voice off"}
        </button>
      </div>

      <p aria-live="polite" className="mt-4 font-display text-2xl leading-snug text-slate">
        {headline}
      </p>

      {audioDown && (
        <p role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn">
          Audio unavailable, so guidance is shown as text only{lastError ? ` (${lastError})` : ""}.
          <button
            onClick={() => queue.retry()}
            className="rounded-full border border-warn/40 px-2 py-0.5 hover:bg-warn/10"
          >
            Retry audio
          </button>
        </p>
      )}

      {result && result.instructions.length > 0 && (
        <ul className="mt-4 divide-y divide-slate/10 text-sm">
          {result.instructions.map((i) => (
            <li key={i.joint} className="flex items-center justify-between gap-3 py-2">
              <span className="capitalize text-ink">{i.joint.replace("_", " ")}</span>
              <span className="tabular-nums text-stone">
                {i.current}° → {i.target}°
              </span>
              <span className={`w-24 text-right font-medium ${Math.abs(i.delta) > 30 ? "text-bad" : "text-warn"}`}>
                {i.direction === "increase" ? "▲ +" : "▼ −"}
                {Math.abs(i.delta)}°
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
