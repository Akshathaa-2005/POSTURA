import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeUtterance {
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  lang = "";
  rate = 1;
  constructor(public text: string) {}
}

async function load(withSpeech: boolean) {
  vi.resetModules();
  const spoken: string[] = [];
  const speechSynthesis = { cancel: vi.fn(), speak: (u: FakeUtterance) => spoken.push(u.text) };
  const win = withSpeech
    ? { speechSynthesis, SpeechSynthesisUtterance: FakeUtterance, localStorage: { setItem: vi.fn(), getItem: vi.fn() } }
    : { localStorage: { setItem: vi.fn(), getItem: vi.fn() } };
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { language: "en-GB" });
  if (withSpeech) vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  const mod = await import("./useCoachVoice");
  return { ...mod, spoken, speechSynthesis };
}

describe("browser speech fallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("detects whether the browser can speak", async () => {
    expect((await load(true)).browserSpeechAvailable()).toBe(true);
    expect((await load(false)).browserSpeechAvailable()).toBe(false);
  });

  it("speaks an offline cue, replacing anything still being said", async () => {
    const { speakLocalCue, spoken, speechSynthesis } = await load(true);
    speakLocalCue("Sink a little deeper", "shallow_squat");
    expect(spoken).toEqual(["Sink a little deeper"]);
    expect(speechSynthesis.cancel).toHaveBeenCalled();
  });

  it("paces offline cues: a gap between cues, and no repeating the same fault soon", async () => {
    const { speakLocalCue, spoken } = await load(true);
    speakLocalCue("one", "a");
    vi.advanceTimersByTime(2000);
    speakLocalCue("two", "b"); // too soon after the last cue
    vi.advanceTimersByTime(5000);
    speakLocalCue("two", "b"); // gap has passed
    vi.advanceTimersByTime(7000);
    speakLocalCue("one again", "a"); // gap passed, but the same fault was just spoken
    vi.advanceTimersByTime(10000);
    speakLocalCue("one again", "a");
    expect(spoken).toEqual(["one", "two", "one again"]);
  });

  it("stays silent when voice is switched off, or the browser can't speak", async () => {
    const off = await load(true);
    off.useVoice.getState().setEnabled(false);
    off.speakLocalCue("hello", "x");
    expect(off.spoken).toEqual([]);

    const none = await load(false);
    expect(() => none.speakLocalCue("hello", "x")).not.toThrow();
  });
});
