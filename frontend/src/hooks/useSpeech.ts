import { useEffect, useSyncExternalStore } from "react";
import { useWorkoutState } from "@/hooks/useWorkoutState";
import { getSpeechQueue } from "@/utils/speech";

/** Live state of the shared speech queue (speaking / idle / unavailable) plus its controls. */
export function useSpeech() {
  const queue = getSpeechQueue();
  const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getServerSnapshot);
  return { ...state, queue };
}

/**
 * Plays the backend's coaching clips through the shared queue, so they never overlap and fall back to the
 * browser voice if the clip can't be played. (The in-panel player only exists in the sidebar layout.)
 */
export function useCoachVoicePlayback(enabled: boolean) {
  const voice = useWorkoutState((s) => s.coach.voice);
  useEffect(() => {
    const queue = getSpeechQueue();
    if (!enabled) return queue.cancel();
    if (voice) queue.enqueue({ text: voice.text, url: voice.url });
  }, [voice, enabled]);
}
