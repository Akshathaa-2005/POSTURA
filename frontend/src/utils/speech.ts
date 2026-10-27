import { backendUrl } from "./api";

export type SpeechStatus = "idle" | "speaking" | "unavailable";

export interface SpeechSnapshot {
  status: SpeechStatus;
  /** The sentence being spoken right now. */
  current: string | null;
  /** Most recent failure, for the on-screen fallback notice. */
  lastError: string | null;
}

export interface SpeechItem {
  text: string;
  /** A pre-rendered clip (the backend's WAV). Spoken via the browser voice if it fails to play. */
  url?: string;
}

type Engine = (item: SpeechItem, signal: AbortSignal) => Promise<void>;

const MAX_PENDING = 1;
const ERROR_LOG_LIMIT = 20;
/** Failures in a row before audio is declared unavailable (captions only) until retried. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Plays spoken guidance one utterance at a time. Utterances never overlap; while one is playing,
 * only the newest waiting one is kept (stale guidance is dropped, not read out late).
 * Each utterance tries the browser voice, then the backend TTS; if both fail the failure is logged and the
 * caller's on-screen text remains the fallback.
 */
export class SpeechQueue {
  private pending: SpeechItem[] = [];
  private playing = false;
  private abort: AbortController | null = null;
  private failures = 0;
  private listeners = new Set<() => void>();
  private snap: SpeechSnapshot = { status: "idle", current: null, lastError: null };
  /** Failures, newest last — also written to the console. */
  readonly errors: { at: number; engine: string; message: string }[] = [];

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;
  getServerSnapshot = (): SpeechSnapshot => ({ status: "idle", current: null, lastError: null });

  private set(patch: Partial<SpeechSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  private log(engine: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[speech] ${engine} failed: ${message}`);
    this.errors.push({ at: Date.now(), engine, message });
    if (this.errors.length > ERROR_LOG_LIMIT) this.errors.shift();
    this.set({ lastError: `${engine}: ${message}` });
  }

  /** Queues text (or a clip) to be spoken. Safe to call at any rate. */
  enqueue(item: SpeechItem): void {
    if (!item.text.trim()) return;
    if (this.snap.status === "unavailable") return; // captions only until retry()
    if (this.playing && this.snap.current === item.text && !item.url) return; // already saying it
    this.pending.push(item);
    while (this.pending.length > MAX_PENDING) this.pending.shift();
    void this.pump();
  }

  /** Stops speech and drops anything waiting. */
  cancel(): void {
    this.pending = [];
    this.abort?.abort();
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  }

  /** Re-enables audio after it was marked unavailable. Call from a user gesture. */
  retry(): void {
    this.failures = 0;
    this.set({ status: this.playing ? "speaking" : "idle", lastError: null });
    unlockBrowserSpeech();
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    try {
      for (let item = this.pending.shift(); item; item = this.pending.shift()) {
        this.set({ status: "speaking", current: item.text });
        const ok = await this.speak(item);
        this.failures = ok ? 0 : this.failures + 1;
        if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
          this.pending = [];
          this.set({ status: "unavailable", current: null });
          return;
        }
      }
      this.set({ status: "idle", current: null });
    } finally {
      this.playing = false;
    }
  }

  private async speak(item: SpeechItem): Promise<boolean> {
    const controller = (this.abort = new AbortController());
    const engines: [string, Engine][] = [];
    if (item.url) engines.push(["audio-clip", playClip]);
    if (browserSpeechSupported()) engines.push(["browser-tts", browserSpeak]);
    engines.push(["server-tts", serverSpeak]);
    for (const [name, engine] of engines) {
      if (controller.signal.aborted) return true; // cancelled on purpose, not a failure
      try {
        await engine(item, controller.signal);
        return true;
      } catch (err) {
        if (controller.signal.aborted) return true;
        this.log(name, err);
      }
    }
    return false;
  }
}

// ---- Engines ---------------------------------------------------------------------

export function browserSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

/** Browsers only allow speech after a user gesture; a silent utterance during a click unlocks it. */
export function unlockBrowserSpeech(): void {
  if (!browserSpeechSupported()) return;
  try {
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch {
    // ignore — the real utterance will report the failure
  }
}

let firstVoiceProbe: number | null = null;
/** Voices load asynchronously, so an empty list only counts as "none installed" after a grace period. */
function noVoicesInstalled(): boolean {
  const now = Date.now();
  firstVoiceProbe ??= now;
  return window.speechSynthesis.getVoices().length === 0 && now - firstVoiceProbe > 2000;
}

const browserSpeak: Engine = (item, signal) =>
  new Promise<void>((resolve, reject) => {
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.rate = 1.05;
    let done = false;
    // Chrome sometimes never fires `end`; don't let one lost event freeze the queue.
    const watchdog = window.setTimeout(() => finish(new Error("speech timed out")), 4000 + item.text.length * 120);
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      window.clearTimeout(watchdog);
      signal.removeEventListener("abort", onAbort);
      if (err) synth.cancel();
      err ? reject(err) : resolve();
    };
    const onAbort = () => {
      synth.cancel();
      finish();
    };
    signal.addEventListener("abort", onAbort);
    utterance.onend = () => finish();
    utterance.onerror = (e) => {
      if (e.error === "interrupted" || e.error === "canceled") return finish();
      finish(new Error(e.error || "speech error"));
    };
    // No installed voices (e.g. Linux without speech-dispatcher): fail fast so the next engine is tried.
    if (noVoicesInstalled()) return finish(new Error("no speech voices installed"));
    synth.speak(utterance);
  });

const playClip: Engine = (item, signal) => playUrl(item.url!, signal);

function playUrl(url: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const audio = new Audio(url);
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      audio.pause();
      cleanup();
      resolve();
    };
    signal.addEventListener("abort", onAbort);
    audio.onended = () => {
      cleanup();
      resolve();
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error(`could not load ${url}`));
    };
    audio.play().catch((e) => {
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

/** Backend TTS (pyttsx3 → WAV): used when the browser has no voice. */
const serverSpeak: Engine = async (item, signal) => {
  const res = await fetch(backendUrl(`/api/tts?text=${encodeURIComponent(item.text)}`), { signal });
  if (!res.ok) throw new Error(`server TTS returned ${res.status}`);
  const { url } = (await res.json()) as { url: string };
  await playUrl(backendUrl(url), signal);
};

// ---- Shared instance ---------------------------------------------------------------

let shared: SpeechQueue | null = null;
export function getSpeechQueue(): SpeechQueue {
  if (!shared && browserSpeechSupported()) {
    firstVoiceProbe = Date.now();
    window.speechSynthesis.getVoices(); // starts loading the voice list
  }
  return (shared ??= new SpeechQueue());
}
