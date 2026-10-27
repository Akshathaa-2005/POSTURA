import { LM, type Landmark } from "@/types/mediapipe";

/** The twelve limb landmarks that joint angles and fault metrics are built from. */
const BODY = [
  LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_ELBOW, LM.RIGHT_ELBOW, LM.LEFT_WRIST, LM.RIGHT_WRIST,
  LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_KNEE, LM.RIGHT_KNEE, LM.LEFT_ANKLE, LM.RIGHT_ANKLE,
];

/** [proximal, distal] limb segments. A wrong segment length points at the distal landmark. */
const SEGMENTS: [number, number][] = [
  [LM.LEFT_SHOULDER, LM.LEFT_ELBOW], [LM.LEFT_ELBOW, LM.LEFT_WRIST],
  [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW], [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
  [LM.LEFT_HIP, LM.LEFT_KNEE], [LM.LEFT_KNEE, LM.LEFT_ANKLE],
  [LM.RIGHT_HIP, LM.RIGHT_KNEE], [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
];

/**
 * Crossed arms: a wrist landing on the opposite elbow or shoulder. (Wrist-to-wrist is deliberately absent: clapping
 * overhead or clasping hands is a real, well-tracked position. Opposite knees/ankles are absent too: knees touching
 * is the "knees caving" fault itself, and legs hiding one another in side view is handled by picking the near side.)
 */
const CROSS_PAIRS: [number, number][] = [
  [LM.LEFT_WRIST, LM.RIGHT_ELBOW], [LM.RIGHT_WRIST, LM.LEFT_ELBOW],
  [LM.LEFT_WRIST, LM.RIGHT_SHOULDER], [LM.RIGHT_WRIST, LM.LEFT_SHOULDER],
];

/** A landmark becomes trusted at this smoothed visibility and stays trusted until it falls below the lower bound. */
export const TRUST_ON = 0.6;
export const TRUST_OFF = 0.4;
const VISIBILITY_SMOOTHING = 0.5;
/** Opposite-limb landmarks closer than this share of the torso length are treated as overlapping. */
export const OVERLAP_FRACTION = 0.1;
/**
 * A limb segment stretched beyond this multiple of its usual length (relative to the torso) means its end point is a
 * guess. Only stretching is used: a *short* segment is ambiguous (a limb pointing at the camera really is shorter in 2D),
 * and the collapsed-onto-another-limb case is caught by the overlap check instead.
 */
export const BONE_RATIO_MAX = 1.6;
const BONE_WARMUP_SAMPLES = 20;
/** A flagged landmark stays untrusted this many frames after its last flag, so it can't flicker back in. */
const REARM_FRAMES = 4;

export interface Reliable {
  /** Same landmarks, with unreliable limb landmarks given visibility 0 so every consumer ignores them. */
  landmarks: Landmark[];
  /** Limb landmarks dropped because of low confidence, overlap or an implausible limb length. */
  unreliable: number[];
}

/**
 * The pose model reports a position and a visibility for every landmark, but it also *invents* positions for
 * hidden joints (the far limb in side view, wrists behind the torso, crossed arms) and often keeps their visibility
 * high. This filters those out using three cues: smoothed visibility with hysteresis, overlap between opposite
 * limbs, and limb-length consistency against what this user's limbs normally measure.
 */
export class LandmarkReliability {
  private vis = new Array<number>(33).fill(0);
  private trusted = new Array<boolean>(33).fill(false);
  private holdoff = new Array<number>(33).fill(0);
  private primed = false;
  private bone = new Map<number, { ratio: number; n: number }>();

  reset(): void {
    this.vis.fill(0);
    this.trusted.fill(false);
    this.holdoff.fill(0);
    this.primed = false;
    this.bone.clear();
  }

  /** `checkOverlap` is for front views, where opposite limbs should stay apart; in side view they legitimately coincide. */
  sanitize(lm: Landmark[], width: number, height: number, checkOverlap: boolean): Reliable {
    for (const i of BODY) {
      const v = lm[i]?.visibility ?? 0;
      this.vis[i] = this.primed ? this.vis[i] + VISIBILITY_SMOOTHING * (v - this.vis[i]) : v;
      if (this.trusted[i] ? this.vis[i] < TRUST_OFF : this.vis[i] >= TRUST_ON) this.trusted[i] = !this.trusted[i];
    }
    this.primed = true;

    const flagged = new Set<number>();
    const px = (i: number) => ({ x: lm[i].x * width, y: lm[i].y * height });
    const dist = (a: number, b: number) => Math.hypot(px(a).x - px(b).x, px(a).y - px(b).y);
    const torso = this.torsoLength(lm, width, height);

    if (torso > 0) {
      if (checkOverlap) {
        for (const [a, b] of CROSS_PAIRS) {
          if (this.trusted[a] && this.trusted[b] && dist(a, b) < OVERLAP_FRACTION * torso) {
            flagged.add(a);
            flagged.add(b);
          }
        }
      }
      for (const [prox, distal] of SEGMENTS) {
        if (!this.trusted[prox] || !this.trusted[distal] || flagged.has(prox) || flagged.has(distal)) continue;
        const ratio = dist(prox, distal) / torso;
        const ref = this.bone.get(distal);
        if (ref && ref.n >= BONE_WARMUP_SAMPLES && ratio > BONE_RATIO_MAX * ref.ratio) {
          flagged.add(distal);
        } else {
          // Learn only from plausible samples, so a bad stretch can't redefine "normal".
          const n = (ref?.n ?? 0) + 1;
          this.bone.set(distal, { ratio: (ref?.ratio ?? 0) + (ratio - (ref?.ratio ?? 0)) * Math.max(0.05, 1 / n), n });
        }
      }
    }

    const unreliable: number[] = [];
    const landmarks = lm.slice();
    for (const i of BODY) {
      this.holdoff[i] = flagged.has(i) ? REARM_FRAMES : Math.max(0, this.holdoff[i] - 1);
      if (!this.trusted[i] || this.holdoff[i] > 0) {
        unreliable.push(i);
        landmarks[i] = { ...lm[i], visibility: 0 };
      } else {
        landmarks[i] = { ...lm[i], visibility: this.vis[i] };
      }
    }
    return { landmarks, unreliable };
  }

  /** Shoulder-to-hip distance in pixels from whichever shoulders/hips are trusted; 0 if unknown. */
  private torsoLength(lm: Landmark[], width: number, height: number): number {
    const mid = (ids: number[]) => {
      const pts = ids.filter((i) => this.trusted[i] && lm[i]);
      return pts.length
        ? { x: (pts.reduce((s, i) => s + lm[i].x, 0) / pts.length) * width, y: (pts.reduce((s, i) => s + lm[i].y, 0) / pts.length) * height }
        : null;
    };
    const s = mid([LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER]);
    const h = mid([LM.LEFT_HIP, LM.RIGHT_HIP]);
    return s && h ? Math.hypot(s.x - h.x, s.y - h.y) : 0;
  }
}
