import type { Landmark } from "@/types/mediapipe";
import type { RepWindow } from "@/types";
import { CONTEXT_DIM, SPEC, V, normalizeFrame, type NormalizedFrame, type Transform } from "./skeleton";

const PREROLL: number = SPEC.preroll_frames;
const MAX_FRAMES: number = SPEC.max_frames;

/** Collects the normalised skeleton for one rep (plus a few frames of lead-in) so it can be recorded or scored. */
export class RepRecorder {
  private prev: Transform | null = null;
  private pre: NormalizedFrame[] = [];
  private active: NormalizedFrame[] = [];
  private overflowed = false;

  /** `moving` is true from the frame the rep leaves the start position until the frame it returns. */
  push(lm: Landmark[], width: number, height: number, moving: boolean) {
    const frame = normalizeFrame(lm, width, height, this.prev);
    this.prev = frame.transform;
    if (moving) {
      if (this.active.length < MAX_FRAMES) this.active.push(frame);
      else this.overflowed = true;
    } else {
      this.pre.push(frame);
      if (this.pre.length > PREROLL) this.pre.shift();
    }
  }

  finish(): RepWindow | null {
    const frames = [...this.pre.slice(-PREROLL), ...this.active];
    const ok = !this.overflowed && this.active.length >= 4 && frames.length >= 8;
    this.discard();
    if (!ok) return null;
    const joints = new Float64Array(frames.length * V * 3);
    const context = new Float64Array(frames.length * CONTEXT_DIM);
    frames.forEach((f, i) => {
      joints.set(f.joints, i * V * 3);
      context.set(f.context, i * CONTEXT_DIM);
    });
    return { frames: frames.length, joints, context };
  }

  discard() {
    this.active = [];
    this.overflowed = false;
  }

  reset() {
    this.discard();
    this.pre = [];
    this.prev = null;
  }
}
