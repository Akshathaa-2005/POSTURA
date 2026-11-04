import { describe, expect, it } from "vitest";
import type { RepConfig } from "@/types";
import { checkTempo, tempoConfigProblems } from "./repConstraints";

const base: RepConfig = { metric: "knee", direction: "decrease", start_threshold: 160, peak_threshold: 100 };

describe("checkTempo", () => {
  it("accepts anything when no limits are set", () => {
    expect(checkTempo(base, 10)).toEqual({ ok: true });
    expect(checkTempo(base, 1e9)).toEqual({ ok: true });
  });

  it("rejects bounced and stalled reps, inclusive of the limits themselves", () => {
    const cfg = { ...base, min_duration_ms: 700, max_duration_ms: 6000 };
    expect(checkTempo(cfg, 699)).toMatchObject({ ok: false, reason: "too_fast" });
    expect(checkTempo(cfg, 700)).toEqual({ ok: true });
    expect(checkTempo(cfg, 6000)).toEqual({ ok: true });
    expect(checkTempo(cfg, 6001)).toMatchObject({ ok: false, reason: "too_slow" });
  });

  it("doesn't hold an unknown duration against the rep", () => {
    expect(checkTempo({ ...base, min_duration_ms: 700 }, undefined)).toEqual({ ok: true });
  });
});

describe("tempoConfigProblems", () => {
  it("flags nonsense limits", () => {
    expect(tempoConfigProblems(base)).toEqual([]);
    expect(tempoConfigProblems({ ...base, min_duration_ms: 0 })).toHaveLength(1);
    expect(tempoConfigProblems({ ...base, min_duration_ms: 900, max_duration_ms: 900 })).toHaveLength(1);
    expect(tempoConfigProblems({ ...base, min_duration_ms: 500, max_duration_ms: 900 })).toEqual([]);
  });
});
