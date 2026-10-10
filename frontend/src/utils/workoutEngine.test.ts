import { describe, expect, it } from "vitest";
import type { Landmark } from "@/types/mediapipe";
import type { FormIssue, RepEvent } from "@/types";
import { getExercise } from "./exercises";
import { computeAngle } from "./poseValidation";
import { WorkoutEngine, type EngineSnapshot } from "./workoutEngine";

const W = 1000;
const H = 1000;
const FRAME_MS = 33;

type P = [number, number];
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const rad = (d: number) => (d * Math.PI) / 180;

/** Builds 33 landmarks from pixel points; unspecified ones sit at the centre, invisible. */
function landmarks(points: Record<number, P>, visibility: Record<number, number> = {}): Landmark[] {
  return Array.from({ length: 33 }, (_, i) => {
    const p = points[i];
    return p
      ? { x: p[0] / W, y: p[1] / H, z: 0, visibility: visibility[i] ?? 0.99 }
      : { x: 0.5, y: 0.5, z: 0, visibility: 0 };
  });
}

/** Side-view standing/squatting figure facing +x. `knee` is the knee angle, `lean` the torso lean. */
function sidePose({ knee = 175, lean = 5, elbow = 170, shoulder = 10, farVisibility = 0.2, farGarbage = false } = {}) {
  const s = (180 - knee) / 2;
  const A: P = [500, 900];
  const K = add(A, [200 * Math.sin(rad(s)), -200 * Math.cos(rad(s))]);
  const Hp = add(K, [-200 * Math.sin(rad(s)), -200 * Math.cos(rad(s))]);
  const S = add(Hp, [250 * Math.sin(rad(lean)), -250 * Math.cos(rad(lean))]);
  // Upper arm `shoulder`° forward of the torso line, forearm bent by `elbow`.
  const torsoDown = rad(lean); // direction shoulder→hip is (−sin lean, cos lean)
  const armDir = torsoDown - rad(shoulder);
  const E = add(S, [-120 * Math.sin(armDir), 120 * Math.cos(armDir)]);
  const foreDir = armDir - rad(180 - elbow);
  const Wr = add(E, [-120 * Math.sin(foreDir), 120 * Math.cos(foreDir)]);
  const nose = add(S, [30, -70]);
  const near = { 11: S, 13: E, 15: Wr, 23: Hp, 25: K, 27: A };
  const far: Record<number, P> = farGarbage
    ? { 12: [100, 100], 14: [900, 120], 16: [120, 880], 24: [880, 300], 26: [100, 600], 28: [900, 950] }
    : { 12: S, 14: E, 16: Wr, 24: Hp, 26: K, 28: A };
  const vis = Object.fromEntries(Object.keys(far).map((k) => [Number(k), farVisibility]));
  return landmarks({ 0: nose, ...near, ...far }, vis);
}

/** Horizontal push-up figure. `sag` px pushes the hip below (+) or above (−) the shoulder–ankle line. */
function plankPose({ elbow = 175, sag = 0 } = {}) {
  const S: P = [700, 600];
  const A: P = [200, 640];
  const Hp: P = [(S[0] + A[0]) / 2, (S[1] + A[1]) / 2 + sag];
  const K: P = [(Hp[0] + A[0]) / 2, (Hp[1] + A[1]) / 2];
  const d = 2 * 100 * Math.sin(rad(elbow / 2));
  const Wr: P = [S[0], S[1] + d];
  const E: P = [S[0] - 100 * Math.cos(rad(elbow / 2)), S[1] + d / 2];
  const pts = { 0: [760, 590] as P, 11: S, 13: E, 15: Wr, 23: Hp, 25: K, 27: A };
  const far = { 12: S, 14: E, 16: Wr, 24: Hp, 26: K, 28: A };
  return landmarks({ ...pts, ...far }, { 12: 0.2, 14: 0.2, 16: 0.2, 24: 0.2, 26: 0.2, 28: 0.2 });
}

/** Front-facing figure; `left`/`right` are shoulder abduction angles (0 = arms down, 180 = overhead). */
function frontPose({
  left = 10,
  right = 10,
  stance = 0.6,
  leftKneeY = 750,
  hipY = 600,
  kneeSpread,
}: {
  left?: number;
  right?: number;
  stance?: number;
  leftKneeY?: number;
  hipY?: number;
  /** Absolute knee x offset from centre (overrides the default, which follows the stance). */
  kneeSpread?: number;
}) {
  const LS: P = [550, 300]; // person's left appears on image right when facing the camera
  const RS: P = [450, 300];
  const arm = (S: P, a: number, out: 1 | -1): [P, P] => {
    const v: P = [out * Math.sin(rad(a)), Math.cos(rad(a))];
    const E = add(S, [120 * v[0], 120 * v[1]]);
    return [E, add(E, [120 * v[0], 120 * v[1]])];
  };
  const [LE, LW] = arm(LS, left, 1);
  const [RE, RW] = arm(RS, right, -1);
  const half = (stance * 100) / 2;
  return landmarks({
    0: [500, 230],
    11: LS, 12: RS, 13: LE, 14: RE, 15: LW, 16: RW,
    23: [530, hipY], 24: [470, hipY],
    25: [500 + (kneeSpread ?? half * 0.8 + 20), leftKneeY], 26: [500 - (kneeSpread ?? half * 0.8 + 20), 750],
    27: [500 + half, 900], 28: [500 - half, 900],
  });
}

interface Run {
  snaps: EngineSnapshot[];
  reps: RepEvent[];
  coached: FormIssue[];
  praise: number;
}

/** Feeds each pose for `hold` frames, then linearly blends to the next. */
function run(engine: WorkoutEngine, poses: Landmark[][], { hold = 6, blend = 6, start = 0 } = {}): Run {
  const out: Run = { snaps: [], reps: [], coached: [], praise: 0 };
  let now = start;
  const feed = (lm: Landmark[]) => {
    const s = engine.process(lm, W, H, now);
    now += FRAME_MS;
    out.snaps.push(s);
    if (s.repEvent) out.reps.push(s.repEvent);
    if (s.coachIssue) out.coached.push(s.coachIssue);
    if (s.praise) out.praise++;
  };
  poses.forEach((pose, i) => {
    for (let f = 0; f < hold; f++) feed(pose);
    const next = poses[i + 1];
    if (!next) return;
    for (let f = 1; f <= blend; f++) {
      const t = f / (blend + 1);
      feed(pose.map((p, k) => ({ ...p, x: p.x + (next[k].x - p.x) * t, y: p.y + (next[k].y - p.y) * t })));
    }
  });
  return out;
}

const repeat = <T,>(xs: T[], n: number) => Array.from({ length: n }, () => xs).flat();
const last = (r: Run) => r.snaps[r.snaps.length - 1];

describe("pose generators", () => {
  it("produce the requested angles", () => {
    const lm = sidePose({ knee: 95 });
    expect(computeAngle(lm[23], lm[25], lm[27], W, H)).toBeCloseTo(95, 0);
    const pl = plankPose({ elbow: 90 });
    expect(computeAngle(pl[11], pl[13], pl[15], W, H)).toBeCloseTo(90, 0);
  });
});

describe("squat (side view)", () => {
  const squat = getExercise("squat")!;

  it("counts deep reps cleanly and praises a streak", () => {
    const r = run(new WorkoutEngine(squat), repeat([sidePose({ knee: 175 }), sidePose({ knee: 85, lean: 35 })], 3).concat([sidePose()]));
    expect(r.reps.map((e) => e.type)).toEqual(["rep", "rep", "rep"]);
    expect(r.reps.every((e) => e.faults.length === 0)).toBe(true);
    expect(r.coached).toEqual([]);
    expect(r.praise).toBe(1);
  });

  it("coaches depth on a shallow rep that still counts", () => {
    const r = run(new WorkoutEngine(squat), [sidePose(), sidePose({ knee: 96 }), sidePose()]);
    expect(r.reps).toHaveLength(1);
    expect(r.reps[0].type).toBe("rep");
    expect(r.reps[0].faults[0].rule.id).toBe("shallow_squat");
    expect(r.coached[0]).toMatchObject({ id: "shallow_squat", status: "warn", fromRep: true });
    expect(last(r).issue?.message).toMatch(/thighs parallel/);
  });

  it("flags a half squat as a partial rep with a major depth fault", () => {
    const r = run(new WorkoutEngine(squat), [sidePose(), sidePose({ knee: 125 }), sidePose()]);
    expect(r.reps).toHaveLength(1);
    expect(r.reps[0]).toMatchObject({ type: "partial" });
    expect(r.reps[0].faults[0]).toMatchObject({ status: "bad" });
    expect(last(r).reps).toBe(0);
  });

  it("catches the chest dropping during the squat", () => {
    const r = run(new WorkoutEngine(squat), [sidePose(), sidePose({ knee: 90, lean: 65 })], { hold: 20 });
    expect(r.coached.map((i) => i.id)).toContain("chest_forward");
    expect(r.coached.find((i) => i.id === "chest_forward")?.status).toBe("bad");
  });

  it("ignores the hidden far side, even when the model guesses it wildly", () => {
    const r = run(
      new WorkoutEngine(squat),
      repeat([sidePose({ farGarbage: true }), sidePose({ knee: 85, lean: 30, farGarbage: true })], 2).concat([
        sidePose({ farGarbage: true }),
      ]),
    );
    expect(r.reps.map((e) => e.type)).toEqual(["rep", "rep"]);
    expect(r.coached).toEqual([]);
  });
});

describe("push-up (side view)", () => {
  const pushUp = getExercise("push_up")!;

  it("asks for a plank first and doesn't count reps while standing", () => {
    const r = run(new WorkoutEngine(pushUp), repeat([sidePose({ elbow: 170 }), sidePose({ elbow: 70 })], 3), { hold: 10 });
    expect(r.reps).toEqual([]);
    expect(r.coached[0]).toMatchObject({ id: "setup" });
    expect(last(r).issue?.message).toMatch(/high plank/);
  });

  it("detects sagging hips and lifted hips with distinct cues", () => {
    // 50 px on a ~500 px body ≈ 10% (minor); 90 px ≈ 18% (major)
    const mild = run(new WorkoutEngine(pushUp), [plankPose({ sag: 50 })], { hold: 30 });
    expect(last(mild).issue).toMatchObject({ id: "hips_sagging", status: "warn" });
    const sag = run(new WorkoutEngine(pushUp), [plankPose({ sag: 90 })], { hold: 30 });
    expect(last(sag).issue).toMatchObject({ id: "hips_sagging", status: "bad" });
    const pike = run(new WorkoutEngine(pushUp), [plankPose({ sag: -60 })], { hold: 30 });
    expect(last(pike).issue).toMatchObject({ id: "hips_piking" });
    const good = run(new WorkoutEngine(pushUp), [plankPose()], { hold: 30 });
    expect(last(good).issue).toBeNull();
  });

  it("does not flag a brief sag (debounce)", () => {
    const r = run(new WorkoutEngine(pushUp), [plankPose(), plankPose({ sag: 60 }), plankPose()], { hold: 6, blend: 1 });
    expect(r.coached).toEqual([]);
  });

  it("counts full push-ups and coaches shallow ones", () => {
    const r = run(new WorkoutEngine(pushUp), [plankPose(), plankPose({ elbow: 85 }), plankPose(), plankPose({ elbow: 95 }), plankPose()]);
    expect(r.reps.map((e) => [e.type, e.faults.map((f) => f.rule.id)])).toEqual([
      ["rep", []],
      ["rep", ["shallow_push_up"]],
    ]);
  });
});

describe("jumping jack (front view)", () => {
  const jj = getExercise("jumping_jack")!;

  it("names the side whose arm doesn't reach overhead", () => {
    const r = run(new WorkoutEngine(jj), [
      frontPose({ left: 10, right: 10, stance: 0.6 }),
      frontPose({ left: 100, right: 175, stance: 2 }),
      frontPose({ left: 10, right: 10, stance: 0.6 }),
    ]);
    expect(r.reps).toHaveLength(1);
    const issue = r.coached.find((i) => i.id === "arms_not_overhead");
    expect(issue).toMatchObject({ side: "left" });
    expect(issue?.message).toBe("Your left arm isn't reaching overhead — swing it all the way up");
  });

  it("coaches narrow feet", () => {
    const r = run(new WorkoutEngine(jj), [frontPose({ stance: 0.6 }), frontPose({ left: 175, right: 175, stance: 0.8 }), frontPose({})]);
    expect(r.reps[0].faults.map((f) => f.rule.id)).toEqual(["feet_narrow"]);
  });
});

describe("bicep curl (side view)", () => {
  const curl = getExercise("bicep_curl")!;

  it("flags the elbow drifting forward", () => {
    const r = run(new WorkoutEngine(curl), [sidePose({ elbow: 160, shoulder: 50 })], { hold: 30 });
    expect(last(r).issue).toMatchObject({ id: "elbow_drift", status: "bad" });
  });

  it("counts a full curl and coaches a partial one", () => {
    const r = run(new WorkoutEngine(curl), [
      sidePose({ elbow: 165 }),
      sidePose({ elbow: 40 }),
      sidePose({ elbow: 165 }),
      sidePose({ elbow: 55 }),
      sidePose({ elbow: 165 }),
    ]);
    expect(r.reps.map((e) => [e.type, e.faults.map((f) => f.rule.id)])).toEqual([
      ["rep", []],
      ["rep", ["partial_curl"]],
    ]);
  });
});

describe("holds", () => {
  const plank = getExercise("plank")!;
  const secs = (r: Run) => last(r).holdMs / 1000;

  it("times a clean plank and doesn't count reps", () => {
    const r = run(new WorkoutEngine(plank), [plankPose()], { hold: 92 }); // ~3 s
    expect(secs(r)).toBeGreaterThan(2.8);
    expect(secs(r)).toBeLessThan(3.2);
    expect(last(r).reps).toBe(0);
  });

  it("stops the clock while the hips sag badly", () => {
    const r = run(new WorkoutEngine(plank), [plankPose({ sag: 90 })], { hold: 92 });
    expect(secs(r)).toBeLessThan(0.6); // only the confirmation window before the fault is recognised
    expect(last(r).issue).toMatchObject({ id: "hips_sagging", status: "bad" });
  });

  it("doesn't start the clock until the plank position is held", () => {
    const r = run(new WorkoutEngine(plank), [sidePose()], { hold: 92 });
    expect(secs(r)).toBe(0);
    expect(last(r).issue).toMatchObject({ id: "setup" });
  });

  it("praises every 10 s of clean holding", () => {
    const r = run(new WorkoutEngine(plank), [plankPose()], { hold: 640 }); // ~21 s
    expect(r.praise).toBe(2);
  });

  it("coaches a wall sit that is too high, but keeps timing it", () => {
    const wallSit = getExercise("wall_sit")!;
    const r = run(new WorkoutEngine(wallSit), [sidePose({ knee: 110, lean: 5 })], { hold: 60 });
    expect(last(r).issue).toMatchObject({ id: "too_high", status: "warn" });
    expect(secs(r)).toBeGreaterThan(1.5);
  });
});

describe("new metrics", () => {
  it("counts high knees and coaches low ones", () => {
    const hk = getExercise("high_knees")!;
    const r = run(new WorkoutEngine(hk), [
      frontPose({}),
      frontPose({ leftKneeY: 605 }), // knee at hip height
      frontPose({}),
      frontPose({ leftKneeY: 635 }), // counted, but low
      frontPose({}),
    ]);
    expect(r.reps.map((e) => [e.type, e.faults.map((f) => f.rule.id)])).toEqual([
      ["rep", []],
      ["rep", ["low_knees"]],
    ]);
  });

  it("catches knees caving in a sumo squat", () => {
    const sumo = getExercise("sumo_squat")!;
    const stand = frontPose({ stance: 1.8, kneeSpread: 75 });
    const good = run(new WorkoutEngine(sumo), [stand, frontPose({ stance: 1.8, hipY: 720, kneeSpread: 120 }), stand]);
    expect(good.reps.map((e) => e.type)).toEqual(["rep"]);
    expect(good.coached.map((i) => i.id)).not.toContain("knees_caving");

    const caving = run(new WorkoutEngine(sumo), [stand, frontPose({ stance: 1.8, hipY: 700, kneeSpread: 20 })], { hold: 30 });
    expect(caving.coached.map((i) => i.id)).toContain("knees_caving");
  });
});

describe("reps only count with acceptable form", () => {
  const squat = getExercise("squat")!;

  it("doesn't count a quarter squat", () => {
    const r = run(new WorkoutEngine(squat), [sidePose(), sidePose({ knee: 112 }), sidePose()]);
    expect(last(r).reps).toBe(0);
    expect(r.reps[0]).toMatchObject({ type: "partial" });
    expect(r.reps[0].faults[0]).toMatchObject({ status: "bad", rule: { id: "shallow_squat" } });
  });

  it("doesn't count a deep push-up done with sagging hips", () => {
    const r = run(new WorkoutEngine(getExercise("push_up")!), [
      plankPose({ sag: 90 }),
      plankPose({ elbow: 85, sag: 90 }),
      plankPose({ sag: 90 }),
    ]);
    expect(last(r).reps).toBe(0);
    expect(r.reps[0].type).toBe("partial");
    expect(r.reps[0].faults.map((f) => f.rule.id)).toContain("hips_sagging");
  });

  it("doesn't count a full curl when the elbow swings forward", () => {
    const r = run(new WorkoutEngine(getExercise("bicep_curl")!), [
      sidePose({ elbow: 165 }),
      sidePose({ elbow: 40, shoulder: 60 }),
      sidePose({ elbow: 165 }),
    ]);
    expect(last(r).reps).toBe(0);
    expect(r.reps[0].faults[0].rule.id).toBe("elbow_drift");
  });

  it("doesn't count a rep when the body leaves the frame for most of it", () => {
    const engine = new WorkoutEngine(squat);
    let now = 0;
    const feed = (lm: Landmark[] | null, n: number) => {
      let s: EngineSnapshot | null = null;
      for (let i = 0; i < n; i++, now += FRAME_MS) s = engine.process(lm, W, H, now);
      return s!;
    };
    feed(sidePose(), 8);
    feed(sidePose({ knee: 140 }), 3);
    feed(null, 20);
    feed(sidePose({ knee: 85, lean: 30 }), 3);
    const end = feed(sidePose(), 8);
    expect(end.reps).toBe(0);
  });

  it("still counts a good squat with a minor depth cue", () => {
    const r = run(new WorkoutEngine(squat), [sidePose(), sidePose({ knee: 96 }), sidePose()]);
    expect(last(r).reps).toBe(1);
    expect(r.reps[0].faults[0]).toMatchObject({ status: "warn" });
  });
});
