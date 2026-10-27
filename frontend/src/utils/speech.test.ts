import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechQueue } from "./speech";

/** Browser speech stub: each utterance "plays" for 10 ms, or errors. Tracks overlap. */
function stubBrowser(opts: { fail?: boolean } = {}) {
  const spoken: string[] = [];
  let active = 0;
  let maxActive = 0;
  class Utterance {
    onend: (() => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    constructor(public text: string) {}
  }
  const synth = {
    getVoices: () => [{}],
    cancel: vi.fn(),
    speak(u: Utterance) {
      spoken.push(u.text);
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        if (opts.fail) u.onerror?.({ error: "synthesis-failed" });
        else u.onend?.();
      }, 10);
    },
  };
  vi.stubGlobal("window", { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance, setTimeout, clearTimeout });
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  return { spoken, maxActive: () => maxActive };
}

const settle = () => new Promise((r) => setTimeout(r, 120));

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SpeechQueue", () => {
  it("never overlaps and keeps only the newest waiting sentence", async () => {
    const b = stubBrowser();
    const q = new SpeechQueue();
    q.enqueue({ text: "one" });
    q.enqueue({ text: "two" });
    q.enqueue({ text: "three" });
    await settle();
    expect(b.spoken).toEqual(["one", "three"]);
    expect(b.maxActive()).toBe(1);
    expect(q.getSnapshot().status).toBe("idle");
  });

  it("logs failures, falls back to the server voice, and reports unavailable after repeated failure", async () => {
    stubBrowser({ fail: true });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);
    const q = new SpeechQueue();
    for (let i = 0; i < 3; i++) {
      q.enqueue({ text: `cue ${i}` });
      await settle();
    }
    expect(fetchMock).toHaveBeenCalledTimes(3); // server fallback was tried each time
    expect(q.errors.some((e) => e.engine === "browser-tts")).toBe(true);
    expect(q.errors.some((e) => e.engine === "server-tts")).toBe(true);
    expect(q.getSnapshot().status).toBe("unavailable");
    expect(console.warn).toHaveBeenCalled();
    q.enqueue({ text: "ignored" }); // captions only until retry
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
