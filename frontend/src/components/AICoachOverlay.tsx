import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import { STATUS_COLORS } from "@/utils/formatters";

const SOURCE_LABEL = { llm: "AI coach", cache: "AI coach", template: "Coach" } as const;

export default function AICoachOverlay() {
  const coach = useWorkoutState((s) => s.coach);
  const cameraOn = useWorkoutState((s) => s.status !== "idle");
  const [voiceOn, setVoiceOn] = useLocalStorage("aicoach.voice", true);
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Play each new voice clip as it arrives.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !coach.voice || !voiceOn) return;
    audio.src = coach.voice.url;
    audio.play().catch(() => setSpeaking(false)); // autoplay can be blocked until the user interacts
  }, [coach.voice, voiceOn]);

  useEffect(() => {
    if (!voiceOn) audioRef.current?.pause();
  }, [voiceOn]);

  const { connection, llm, tts, correction } = coach;
  const status =
    connection === "online"
      ? { dot: "bg-good", label: llm ? "Live · AI corrections" : "Live · guided corrections" }
      : connection === "connecting"
        ? { dot: "bg-warn animate-pulse", label: "Connecting to coach…" }
        : { dot: "bg-stone/50", label: cameraOn ? "Coach offline · on-device feedback" : "Starts with your camera" };

  return (
    <section className="card p-6">
      <div className="flex items-center gap-3">
        <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-cream">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/postura-mark.png" alt="" className="h-9 w-auto" />
          <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-linen ${status.dot}`} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="eyebrow">Your coach</h2>
          <p className="truncate text-xs text-stone">{status.label}</p>
        </div>
        <div className="flex items-end gap-[3px]" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={`h-5 w-[3px] origin-bottom rounded-full bg-taupe ${speaking ? "animate-wave" : "scale-y-[0.25]"}`}
              style={{ animationDelay: `${i * 0.12}s` }}
            />
          ))}
        </div>
        <button
          onClick={() => setVoiceOn((v) => !v)}
          disabled={connection === "online" && !tts}
          aria-pressed={voiceOn}
          title={tts ? undefined : "Voice synthesis is unavailable on the server"}
          className={`pill !px-3 !py-1 text-xs ${voiceOn ? "border-slate bg-slate text-linen" : "border-slate/15 text-stone"}`}
        >
          {voiceOn ? "Voice on" : "Voice off"}
        </button>
      </div>

      <AnimatePresence mode="wait">
        {correction ? (
          <motion.blockquote
            key={correction.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="mt-5 border-l-2 pl-4"
            style={{ borderColor: STATUS_COLORS[correction.status] }}
          >
            <p className="font-display text-xl italic leading-snug text-slate">“{correction.text}”</p>
            <footer className="eyebrow mt-2 !text-[10px]">{SOURCE_LABEL[correction.source]}</footer>
          </motion.blockquote>
        ) : (
          <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-5 text-sm font-light text-stone">
            {connection === "online"
              ? "Listening. Spoken guidance will appear here when your form needs a nudge."
              : "Start the backend for spoken AI coaching. Visual feedback works without it."}
          </motion.p>
        )}
      </AnimatePresence>

      <audio
        ref={audioRef}
        preload="auto"
        onPlay={() => setSpeaking(true)}
        onEnded={() => setSpeaking(false)}
        onPause={() => setSpeaking(false)}
        onError={() => setSpeaking(false)}
      />
    </section>
  );
}
