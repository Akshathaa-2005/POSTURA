import { LM, type Landmark } from "@/types/mediapipe";
import { MIN_VISIBILITY } from "@/utils/poseValidation";

/**
 * Occlusion / jitter handling that wraps the raw pose-model output. Two independent stages:
 *
 *  1. `LandmarkSmoother`  – One-Euro filter per landmark: heavy smoothing when a joint is still (kills jitter),
 *                           light smoothing when it moves fast (no lag on the rep itself).
 *  2. `GapFiller`         – when `LandmarkReliability` drops a limb joint (low confidence / overlap / bad bone
 *                           length), keep it alive for a short gap by carrying it along with its parent joint,
 *                           instead of losing the measurement for a frame or two.
 *
 * Both are pure TypeScript with no browser dependencies so they are unit-testable (see occlusion.test.ts).
 */

// ---------------------------------------------------------------------------------------------------------------
// One-Euro filter (Casiez et al., CHI 2012)
// ---------------------------------------------------------------------------------------------------------------

export interface OneEuroParams {
  /** Cutoff (Hz) when the signal is still. Lower = smoother but laggier at rest. */
  minCutoff: number;
  /** How quickly the cutoff opens up with speed. Higher = less lag on fast motion, more jitter. */
  beta: number;
  /** Cutoff (Hz) for the speed estimate itself. */
  dCutoff: number;
}

/**
 * Tuned for landmarks in normalised image units at ~30 fps, for a body whose torso spans `REFERENCE_TORSO` of the
 * frame. Speeds are rescaled by the actual torso length (see `LandmarkSmoother`) so the filter behaves the same
 * whether the user stands near the camera or far from it.
 */
export const DEFAULT_ONE_EURO: OneEuroParams = { minCutoff: 3, beta: 20, dCutoff: 1 };

const lowPassAlpha = (cutoffHz: number, dtSec: number) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
};

const REFERENCE_TORSO = 0.25;

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastT = 0;

  constructor(private readonly p: OneEuroParams = DEFAULT_ONE_EURO) {}

  /** `speedScale` multiplies the measured speed before it opens the cutoff (use REFERENCE_TORSO / torso). */
  filter(value: number, tMs: number, speedScale = 1): number {
    if (this.x === null) {
      this.x = value;
      this.lastT = tMs;
      return value;
    }
    // Guard against duplicate / out-of-order timestamps, which would divide by zero.
    const dt = Math.max(1e-3, (tMs - this.lastT) / 1000);
    this.lastT = tMs;
    const rawSpeed = (value - this.x) / dt;
    this.dx += lowPassAlpha(this.p.dCutoff, dt) * (rawSpeed - this.dx);
    const cutoff = this.p.minCutoff + this.p.beta * Math.abs(this.dx) * speedScale;
    this.x += lowPassAlpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}

/** Shoulder-midpoint to hip-midpoint distance in normalised units (the reference when the torso isn't tracked). */
function torsoLength(lm: Landmark[]): number {
  const [ls, rs, lh, rh] = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP].map((i) => lm[i]);
  if (!ls || !rs || !lh || !rh) return REFERENCE_TORSO;
  return Math.hypot((ls.x + rs.x - lh.x - rh.x) / 2, (ls.y + rs.y - lh.y - rh.y) / 2);
}

/** Smooths all landmarks of a pose. Visibility is passed through untouched; `LandmarkReliability` owns that. */
export class LandmarkSmoother {
  private filters: [OneEuroFilter, OneEuroFilter, OneEuroFilter][] = [];

  constructor(private readonly params: OneEuroParams = DEFAULT_ONE_EURO) {}

  smooth(lm: Landmark[], nowMs: number): Landmark[] {
    const speedScale = REFERENCE_TORSO / Math.max(0.05, torsoLength(lm));
    return lm.map((p, i) => {
      const f = (this.filters[i] ??= [
        new OneEuroFilter(this.params),
        new OneEuroFilter(this.params),
        new OneEuroFilter(this.params),
      ]);
      return {
        ...p,
        x: f[0].filter(p.x, nowMs, speedScale),
        y: f[1].filter(p.y, nowMs, speedScale),
        z: f[2].filter(p.z, nowMs, speedScale),
      };
    });
  }

  reset(): void {
    this.filters = [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Short-gap imputation
// ---------------------------------------------------------------------------------------------------------------

/** Longest an occluded joint is carried before it is declared lost (ms). Longer gaps are guesses, not data. */
export const MAX_GAP_MS = 300;
/**
 * Visibility given to an imputed joint. Deliberately just above `MIN_VISIBILITY` (so measurements keep flowing for
 * the short gap) yet below `TRUST_ON` in landmarkReliability.ts (so it is never mistaken for a real detection).
 */
export const IMPUTED_VISIBILITY = MIN_VISIBILITY + 0.05;

/** Child joint → the joint it hangs off. Processed in this order so a wrist can follow an imputed elbow. */
const CHAIN: [child: number, parent: number][] = [
  [LM.LEFT_ELBOW, LM.LEFT_SHOULDER], [LM.RIGHT_ELBOW, LM.RIGHT_SHOULDER],
  [LM.LEFT_KNEE, LM.LEFT_HIP], [LM.RIGHT_KNEE, LM.RIGHT_HIP],
  [LM.LEFT_WRIST, LM.LEFT_ELBOW], [LM.RIGHT_WRIST, LM.RIGHT_ELBOW],
  [LM.LEFT_ANKLE, LM.LEFT_KNEE], [LM.RIGHT_ANKLE, LM.RIGHT_KNEE],
];
/** Root joints (no parent) are held in place when briefly lost. */
const ROOTS = [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP];

interface Vec3 { x: number; y: number; z: number }
interface Memory {
  pos: Vec3;
  /** Position relative to the parent at the last good frame; null if the parent was unusable then. */
  offset: Vec3 | null;
  at: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export interface GapFilled {
  landmarks: Landmark[];
  /** Joints whose position was inferred this frame rather than measured. */
  imputed: number[];
}

/**
 * Replaces recently-lost joints with `parent_now + (joint − parent)_last_good`, i.e. the limb keeps its last
 * known shape and moves with the body. It cannot know about rotation during the gap, which is why the gap is short.
 *
 * `unreliable` / `unseen` come from `LandmarkReliability.sanitize`. Joints not in `unreliable` are measured and
 * recorded. Only `unseen` ones (low confidence) are imputed: a joint dropped for geometry is being actively
 * mis-placed by the model, and freezing it at its old position would feed stale data into rep counting.
 */
export class GapFiller {
  private memory = new Map<number, Memory>();

  apply(sanitized: Landmark[], unreliable: number[], unseen: number[], nowMs: number): GapFilled {
    const lost = new Set(unreliable);
    const canImpute = new Set(unseen);
    const out = sanitized.slice();
    const imputed: number[] = [];
    /** Joints whose position in `out` can be trusted this frame (measured or imputed). */
    const usable = new Set<number>();

    const record = (i: number, parent?: number) => {
      const pos = sanitized[i];
      const p = parent !== undefined && usable.has(parent) ? out[parent] : null;
      this.memory.set(i, { pos: { x: pos.x, y: pos.y, z: pos.z }, offset: p ? sub(pos, p) : null, at: nowMs });
    };

    for (const i of ROOTS) {
      if (!lost.has(i) && sanitized[i]) {
        usable.add(i);
        record(i);
      } else if (canImpute.has(i)) {
        this.tryImpute(i, undefined, out, usable, imputed, sanitized, nowMs);
      }
    }
    for (const [child, parent] of CHAIN) {
      if (!lost.has(child) && sanitized[child]) {
        usable.add(child);
        record(child, parent);
      } else if (canImpute.has(child)) {
        this.tryImpute(child, parent, out, usable, imputed, sanitized, nowMs);
      }
    }
    return { landmarks: out, imputed };
  }

  private tryImpute(
    i: number,
    parent: number | undefined,
    out: Landmark[],
    usable: Set<number>,
    imputed: number[],
    sanitized: Landmark[],
    nowMs: number,
  ) {
    const mem = this.memory.get(i);
    if (!mem || !sanitized[i] || nowMs - mem.at > MAX_GAP_MS) return;
    const pos = parent !== undefined && mem.offset && usable.has(parent) ? add(out[parent], mem.offset) : mem.pos;
    out[i] = { ...sanitized[i], ...pos, visibility: IMPUTED_VISIBILITY };
    usable.add(i);
    imputed.push(i);
  }

  reset(): void {
    this.memory.clear();
  }
}
