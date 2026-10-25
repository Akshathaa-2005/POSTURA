import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useWorkoutState } from "./useWorkoutState";

const STORAGE_KEY = "aicoach.voice";
/** Offline (no backend) cues are paced locally the way the server paces them: not too often, and no nagging. */
const LOCAL_GAP_MS = 6000;
const LOCAL_SAME_CUE_MS = 15000;

interface VoiceState {
  /** The user's voice on/off choice, shared by every control that shows it. */
  enabled: boolean;
  /** A clip, or the browser's voice, is playing right now. */
  speaking: boolean;
  setEnabled: (on: boolean | ((prev: boolean) => boolean)) => void;
  setSpeaking: (on: boolean) => void;
}

export const useVoice = create<VoiceState>((set, get) => ({
  enabled: true,
  speaking: false,
  setEnabled: (next) => {
    const enabled = typeof next === "function" ? next(get().enabled) : next;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
    } catch {
      // storage unavailable: the choice just won't persist
    }
    set({ enabled });
  },
  setSpeaking: (speaking) => set({ speaking }),
}));

/** The browser's own speech synthesis exists on every OS, unlike the server's engines. */
export function browserSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

function speakInBrowser(text: string) {
  if (!browserSpeechAvailable() || !text.trim()) return;
  const synth = window.speechSynthesis;
  synth.cancel(); // never queue up behind an older cue
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = navigator.language || "en-US";
  utterance.rate = 1;
  utterance.onstart = () => useVoice.getState().setSpeaking(true);
  utterance.onend = utterance.onerror = () => useVoice.getState().setSpeaking(false);
  synth.speak(utterance);
}

let lastLocalAt = -Infinity;
const lastLocalByCue = new Map<string, number>();

/** Speaks a cue on this device when the coaching backend is offline. The backend paces and speaks them otherwise. */
export function speakLocalCue(text: string, key: string) {
  const { enabled } = useVoice.getState();
  const now = Date.now();
  if (!enabled || now - lastLocalAt < LOCAL_GAP_MS || now - (lastLocalByCue.get(key) ?? -Infinity) < LOCAL_SAME_CUE_MS) return;
  lastLocalAt = now;
  lastLocalByCue.set(key, now);
  speakInBrowser(text);
}

/**
 * Plays the coach's voice for the whole workout page, whichever layout is showing. Mount it once.
 * A clip from the server is played when there is one; otherwise (or if it can't play) the browser speaks the text.
 */
export function useCoachVoice() {
  const voice = useWorkoutState((s) => s.coach.voice);
  const enabled = useVoice((s) => s.enabled);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Restore the saved choice after hydration (the store starts on, so server and client markup agree).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null) useVoice.setState({ enabled: JSON.parse(stored) === true });
    } catch {
      // keep the default
    }
  }, []);

  useEffect(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.preload = "auto";
      audio.onplay = () => useVoice.getState().setSpeaking(true);
      audio.onended = audio.onpause = () => useVoice.getState().setSpeaking(false);
      audioRef.current = audio;
    }
    return () => {
      audioRef.current?.pause();
      if (browserSpeechAvailable()) window.speechSynthesis.cancel();
      useVoice.getState().setSpeaking(false);
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !voice || !enabled) return;
    const fallback = () => speakInBrowser(voice.text);
    if (browserSpeechAvailable()) window.speechSynthesis.cancel();
    if (!voice.url) {
      fallback(); // the server can't synthesise speech on this machine
      return;
    }
    audio.onerror = fallback;
    audio.src = voice.url;
    audio.play().catch(fallback); // also covers autoplay being blocked
  }, [voice, enabled]);

  useEffect(() => {
    if (enabled) return;
    audioRef.current?.pause();
    if (browserSpeechAvailable()) window.speechSynthesis.cancel();
    useVoice.getState().setSpeaking(false);
  }, [enabled]);
}
