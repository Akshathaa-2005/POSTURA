import { describe, expect, it } from "vitest";
import type { Landmark } from "@/types/mediapipe";
import type { FormIssue, RepEvent } from "@/types";
import { getExercise } from "./exercises";
import { computeAngle, computeJointAngles, computeMetrics } from "./poseValidation";
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
function sidePose({ knee = 175, lean = 5, elbow = 170, shoulder = 10, farVisibility = 0.2, farGarbage = false, split = 0 } = {}) {
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
  if (split) {
    // Turn the body towards the camera: the far shoulder and hip appear beside the near ones.
    far[12] = [S[0] - split, S[1]];
    far[24] = [Hp[0] - split / 2, Hp[1]];
  }
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
  legs = true,
}: {
  left?: number;
  right?: number;
  stance?: number;
  leftKneeY?: number;
  hipY?: number;
  /** Absolute knee x offset from centre (overrides the default, which follows the stance). */
  kneeSpread?: number;
  /** False simulates a webcam too close to see the legs. */
  legs?: boolean;
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
  }, legs ? {} : { 25: 0, 26: 0, 27: 0, 28: 0 });
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

describe("rep windows for the form model", () => {
  const squat = getExercise("squat")!;
  const reps = (poses: Landmark[][]) => run(new WorkoutEngine(squat), poses).reps;
  const cycle = [sidePose(), sidePose({ knee: 90, lean: 30 }), sidePose()];

  /** The same pose seen by a camera that is further away and off to one side (and slightly rolled). */
  const moved = (pose: Landmark[], k: number, dx: number, dy: number, roll = 0): Landmark[] =>
    pose.map((p) => {
      const x = (p.x * W - 500) * k;
      const y = (p.y * H - 500) * k;
      const c = Math.cos(roll);
      const s = Math.sin(roll);
      return { ...p, x: (x * c - y * s + 500 + dx) / W, y: (x * s + y * c + 500 + dy) / H };
    });

  it("attaches the normalised skeleton to each rep", () => {
    const [rep] = reps(cycle);
    expect(rep.window).toBeDefined();
    const w = rep.window!;
    expect(w.frames).toBeGreaterThanOrEqual(8);
    expect(w.joints.length).toBe(w.frames * 17 * 3);
    expect(w.context.length).toBe(w.frames * 3);
    expect([...w.joints].every(Number.isFinite)).toBe(true);
  });

  it("is the same wherever the camera is and however far away", () => {
    const [near] = reps(cycle);
    const [far] = reps(cycle.map((p) => moved(p, 0.55, -140, 60, (12 * Math.PI) / 180)));
    expect(far.window!.frames).toBe(near.window!.frames);
    for (let i = 0; i < near.window!.joints.length; i++) {
      expect(Math.abs(far.window!.joints[i] - near.window!.joints[i]), `value ${i}`).toBeLessThan(1e-6);
    }
  });

  it("captures not-counted reps too, since those are the ones worth labelling", () => {
    const [rep] = reps([sidePose(), sidePose({ knee: 125 }), sidePose()]);
    expect(rep.type).toBe("partial");
    expect(rep.window).toBeDefined();
  });

  it("captures nothing for a movement that never became a rep", () => {
    const r = run(new WorkoutEngine(squat), [sidePose(), sidePose({ knee: 150 }), sidePose()]);
    expect(r.reps).toEqual([]);
  });
});

describe("jumping jacks need the feet, not just the arms", () => {
  const jj = getExercise("jumping_jack")!;
  const down = (o = {}) => frontPose({ left: 10, right: 10, stance: 0.6, ...o });

  it("counts arms overhead with the feet jumped wide", () => {
    const r = run(new WorkoutEngine(jj), [down(), frontPose({ left: 170, right: 170, stance: 2 }), down()]);
    expect(last(r).reps).toBe(1);
  });

  it("doesn't count raising the arms while standing still", () => {
    const r = run(new WorkoutEngine(jj), [down(), frontPose({ left: 170, right: 170, stance: 0.7 }), down()]);
    expect(last(r).reps).toBe(0);
    expect(r.reps[0]).toMatchObject({ type: "partial" });
    expect(r.reps[0].faults[0]).toMatchObject({ status: "bad", rule: { id: "feet_narrow" } });
  });

  it("doesn't count it with the feet only shoulder-width apart either", () => {
    const r = run(new WorkoutEngine(jj), [down({ stance: 1.1 }), frontPose({ left: 170, right: 170, stance: 1.2 }), down({ stance: 1.1 })]);
    expect(last(r).reps).toBe(0);
  });

  it("doesn't count reps when the legs are out of frame, and says why", () => {
    const r = run(new WorkoutEngine(jj), [down({ legs: false }), frontPose({ left: 170, right: 170, stance: 2, legs: false }), down({ legs: false })]);
    expect(last(r).reps).toBe(0);
    expect(r.reps).toHaveLength(0);
    expect(last(r).issue).toMatchObject({ id: "framed", label: "Can't see you" });
    expect(last(r).issue?.message).toMatch(/feet are in frame/);
  });
});

describe("how much of the body must be in frame", () => {
  const legsOut = (lm: Landmark[]) => lm.map((p, i) => (i >= 23 ? { ...p, y: 1.2 } : p));

  it("counts curls with only the upper body in frame (e.g. seated)", () => {
    const curl = getExercise("bicep_curl")!;
    const r = run(new WorkoutEngine(curl), repeat([legsOut(sidePose({ elbow: 170 })), legsOut(sidePose({ elbow: 40 }))], 3).concat([legsOut(sidePose({ elbow: 170 }))]));
    expect(last(r).reps).toBeGreaterThan(0);
  });

  it("still counts a press whose hands lock out above the top of the frame", () => {
    const press = getExercise("shoulder_press")!;
    const overhead = (elbow: number) => sidePose({ elbow, shoulder: elbow > 150 ? 175 : 90 }).map((p, i) => (i === 15 || i === 16 ? { ...p, y: elbow > 150 ? -0.1 : p.y } : p));
    const r = run(new WorkoutEngine(press), repeat([overhead(80), overhead(170)], 3).concat([overhead(80)]));
    expect(last(r).issue?.id).not.toBe("unseen");
    expect(last(r).reps).toBeGreaterThan(0);
  });

  it("asks for hands and shoulders if the arms leave the frame during a curl", () => {
    const curl = getExercise("bicep_curl")!;
    const noWrist = sidePose({ elbow: 170 }).map((p, i) => (i === 15 || i === 16 ? { ...p, x: 1.3 } : p));
    const r = run(new WorkoutEngine(curl), [noWrist, noWrist, noWrist, noWrist]);
    expect(last(r).issue).toMatchObject({ id: "framed", message: "Keep your shoulders, elbows and hands in frame" });
  });

  it("needs the whole body for a squat", () => {
    const squat = getExercise("squat")!;
    const r = run(new WorkoutEngine(squat), repeat([legsOut(sidePose({ knee: 175 })), legsOut(sidePose({ knee: 85 }))], 3));
    expect(last(r).reps).toBe(0);
    expect(last(r).issue).toMatchObject({ id: "framed", message: "Step back so your whole body is in frame" });
  });
});

describe("camera orientation", () => {
  const curl = getExercise("bicep_curl")!;
  const cycle = (o: object) => [sidePose({ elbow: 165, ...o }), sidePose({ elbow: 40, ...o }), sidePose({ elbow: 165, ...o })];
  /** Facing the camera: both shoulders and hips clearly visible, shoulder width ≈ 0.9 of the torso. */
  const facing = { split: 220, farVisibility: 0.99 };

  it("doesn't count side-view curls while you face the camera, and says to turn", () => {
    const r = run(new WorkoutEngine(curl), cycle(facing), { hold: 12 });
    expect(last(r).reps).toBe(0);
    expect(r.reps).toEqual([]);
    expect(last(r).issue).toMatchObject({ id: "view", label: "Wrong angle" });
    expect(last(r).issue!.message).toMatch(/sideways/i);
  });

  it("counts once you turn side-on", () => {
    const engine = new WorkoutEngine(curl);
    run(engine, cycle(facing), { hold: 12, start: 0 });
    const r = run(engine, cycle({}), { hold: 12, start: 5000 });
    expect(last(r).reps).toBe(1);
    expect(last(r).issue).toBeNull();
  });

  it("never blocks when the far shoulder simply isn't visible", () => {
    const r = run(new WorkoutEngine(curl), cycle({ split: 220, farVisibility: 0.2 }));
    expect(last(r).reps).toBe(1);
  });

  it("doesn't count front-view exercises done side-on", () => {
    const jj = getExercise("jumping_jack")!;
    const sideOn = (p: Landmark[]) => p.map((l, i) => ((i === 12 ? 11 : i === 14 ? 13 : i === 16 ? 15 : i === 24 ? 23 : i === 26 ? 25 : i === 28 ? 27 : i) === i ? l : { ...l, x: p[i - 1].x }));
    const poses = [frontPose({}), frontPose({ left: 170, right: 170, stance: 2 }), frontPose({})].map(sideOn);
    const r = run(new WorkoutEngine(jj), poses, { hold: 12 });
    expect(last(r).reps).toBe(0);
    expect(last(r).issue).toMatchObject({ id: "view" });
  });

  it("doesn't change holds, which are judged from a fixed position", () => {
    const r = run(new WorkoutEngine(getExercise("plank")!), [plankPose()], { hold: 40 });
    expect(last(r).issue).toBeNull();
  });
});

describe("rep quality beyond joint angles", () => {
  const squat = getExercise("squat")!;
  const up = sidePose({ knee: 175 });
  const deep = sidePose({ knee: 85, lean: 35 });

  it("records duration, no reversals and full smoothness on a clean rep", () => {
    const r = run(new WorkoutEngine(squat), [up, deep, up]);
    expect(r.reps[0].type).toBe("rep");
    expect(r.reps[0].quality).toMatchObject({ reversals: 0, smoothness: 100 });
    expect(r.reps[0].quality!.durationMs).toBeGreaterThan(400);
  });

  it("doesn't count a rep that stops and restarts midway", () => {
    const half = sidePose({ knee: 130, lean: 15 });
    const r = run(new WorkoutEngine(squat), [up, deep, half, deep, up]);
    expect(last(r).reps).toBe(0);
    expect(r.reps[0]).toMatchObject({ type: "partial", noteId: "stalled", note: expect.stringContaining("smooth") });
    expect(r.snaps.find((x) => x.issue?.id === "stalled")?.issue).toMatchObject({ label: "Not smooth" });
    expect(r.reps[0].quality!.reversals).toBeGreaterThan(0);
  });

  it("doesn't count a rep rushed through as a bounce, and says so", () => {
    const r = run(new WorkoutEngine(squat), [up, deep, up], { hold: 4, blend: 3 });
    expect(last(r).reps).toBe(0);
    expect(r.reps[0]).toMatchObject({ type: "partial", noteId: "rushed", note: expect.stringContaining("Slow down") });
    expect(r.snaps.find((x) => x.issue?.id === "rushed")?.issue).toMatchObject({ label: "Too fast", fromRep: true });
  });

  it("never rushes cardio: fast jumping jacks still count", () => {
    const jj = getExercise("jumping_jack")!;
    const open = frontPose({ left: 170, right: 170, stance: 1.6 });
    const closed = frontPose({ left: 10, right: 10, stance: 0.6 });
    const r = run(new WorkoutEngine(jj), repeat([closed, open], 3).concat([closed]), { hold: 3, blend: 3 });
    expect(last(r).reps).toBeGreaterThan(0);
  });
});

describe("body cut off by the frame", () => {
  it("ignores hips MediaPipe guesses below the bottom edge, so no reps are counted", () => {
    const squat = getExercise("squat")!;
    const cut = (knee: number) =>
      sidePose({ knee, farVisibility: 0.9 }).map((p, i) => (i === 23 || i === 24 ? { ...p, y: 1.15 } : p));
    const r = run(new WorkoutEngine(squat), repeat([cut(175), cut(85)], 3).concat([cut(175)]));
    expect(last(r).reps).toBe(0);
  });

  it("flags facing the camera even when the hips are out of frame", () => {
    const curl = getExercise("bicep_curl")!;
    const base = sidePose({ split: 380, farVisibility: 0.9 });
    // Nose straight above the shoulder midpoint, as when you really face the camera.
    const nose = { ...base[0], x: (base[11].x + base[12].x) / 2, y: base[11].y - 0.13 };
    const facing = base.map((p, i) => (i === 0 ? nose : i === 23 || i === 24 ? { ...p, y: 1.15 } : p));
    const r = run(new WorkoutEngine(curl), [facing, facing, facing, facing]);
    expect(r.snaps.some((s) => s.issue?.id === "view")).toBe(true);
  });
});

describe("tolerance for a noisy camera", () => {
  const squat = getExercise("squat")!;
  const up = sidePose({ knee: 175 });
  const deep = sidePose({ knee: 85, lean: 35 });

  it("still counts a controlled rep with landmark jitter on the way down and up", () => {
    // A small wobble (about a tenth of the range) in the middle of each phase is jitter, not a stop.
    const wobble = (lm: Landmark[], dx: number) => lm.map((p) => ({ ...p, y: p.y + dx }));
    const down = sidePose({ knee: 130, lean: 15 });
    const downJitter = sidePose({ knee: 140, lean: 15 });
    const r = run(new WorkoutEngine(squat), [up, down, downJitter, down, deep, down, downJitter, down, up].map((lm, i) => wobble(lm, i % 2 ? 0.002 : -0.002)), { hold: 3, blend: 5 });
    expect(r.reps.map((e) => e.type)).toEqual(["rep"]);
    expect(r.reps[0].quality!.reversals).toBeLessThan(2);
  });

  it("still rejects stopping and restarting midway", () => {
    const half = sidePose({ knee: 125, lean: 12 });
    const r = run(new WorkoutEngine(squat), [up, deep, half, deep, up]);
    expect(r.reps[0]).toMatchObject({ type: "partial", noteId: "stalled" });
  });
});

describe("body framing", () => {
  const squat = getExercise("squat")!;
  const up = sidePose({ knee: 175 });
  const deep = sidePose({ knee: 85, lean: 35 });
  /** Moves the whole figure down so the ankles sit at `y` (angles are unchanged). */
  const ankleY = (lm: Landmark[], y: number) => lm.map((p) => ({ ...p, y: p.y + (y - lm[27].y) }));

  it("accepts ankles slightly below the bottom edge, but not ones far outside it", () => {
    const near = run(new WorkoutEngine(squat), repeat([ankleY(up, 1.06), ankleY(deep, 1.06)], 3).concat([ankleY(up, 1.06)]));
    expect(last(near).reps).toBeGreaterThan(0);
    const far = run(new WorkoutEngine(squat), repeat([ankleY(up, 1.3), ankleY(deep, 1.3)], 3));
    expect(last(far).reps).toBe(0);
  });

  it("rides out a brief dropout of the ankles mid-rep instead of pausing", () => {
    const e = new WorkoutEngine(squat);
    const warm = run(e, [up, up], { hold: 8 });
    const dropout = run(e, [ankleY(deep, 1.4)], { hold: 4, start: 1000 });
    expect(dropout.snaps.every((x) => x.issue?.id !== "framed")).toBe(true);
    expect(warm.snaps.length).toBeGreaterThan(0);
  });

  it("does pause, and says why, once the ankles stay out of frame", () => {
    const e = new WorkoutEngine(squat);
    const r = run(e, [ankleY(up, 1.4)], { hold: 15 });
    expect(last(r).issue).toMatchObject({ id: "framed" });
  });
});

describe("hip sag in tilted bodies", () => {
  /** Front view of a side plank: shoulders to ankles run across the image on a slope, hips `drop` px below the line. */
  const sidePlank = (drop: number) => {
    const S: P = [800, 500];
    const A: P = [250, 900];
    const Hp: P = [(S[0] + A[0]) / 2, (S[1] + A[1]) / 2 + drop];
    const K: P = [(Hp[0] + A[0]) / 2, (Hp[1] + A[1]) / 2];
    const pts = { 0: [850, 470] as P, 11: S, 12: S, 13: [S[0], S[1] + 120] as P, 14: [S[0], S[1] + 120] as P, 23: Hp, 24: Hp, 25: K, 26: K, 27: A, 28: A };
    return landmarks(pts);
  };

  it("coaches hips dropping in a side plank", () => {
    const plank = getExercise("side_plank")!;
    const bad = run(new WorkoutEngine(plank), [sidePlank(110)], { hold: 25 });
    expect(bad.coached.find((i) => i.id === "hips_dropping")).toMatchObject({ status: "bad" });
    const fine = run(new WorkoutEngine(plank), [sidePlank(0)], { hold: 25 });
    expect(fine.coached).toEqual([]);
    expect(last(fine).holdMs).toBeGreaterThan(500);
  });

  it("measures sag on a steep line too, with the same sign", () => {
    const steep = (drop: number) => {
      const S: P = [700, 300];
      const A: P = [300, 800];
      const Hp: P = [500, 550 + drop];
      return landmarks({ 11: S, 23: Hp, 27: A });
    };
    const sag = (lm: Landmark[]) => computeMetrics(lm, W, H, computeJointAngles(lm, W, H), ["left"]).global.hip_sag!;
    expect(sag(steep(0))).toBeCloseTo(0, 0);
    expect(sag(steep(60))).toBeGreaterThan(5);
    expect(sag(steep(-60))).toBeLessThan(-5);
  });
});

describe("knee metrics follow the judged side", () => {
  it("ignores a far-side knee that is only weakly detected in side view", () => {
    const lm = sidePose({ knee: 175, farVisibility: 0.7 }).map((p, i) => (i === 26 ? { ...p, x: 0.3, y: 0.62 } : p)); // wild far knee
    const angles = computeJointAngles(lm, W, H);
    const m = computeMetrics(lm, W, H, angles, ["left"]).global;
    expect(m.knee_min).toBeGreaterThan(160);
  });

  it("uses a far-side knee once it is detected confidently", () => {
    const lm = sidePose({ knee: 175, farVisibility: 0.95 }).map((p, i) => (i === 26 ? { ...p, x: 0.3, y: 0.62 } : p));
    const m = computeMetrics(lm, W, H, computeJointAngles(lm, W, H), ["left"]).global;
    expect(m.knee_min).toBeLessThan(160);
  });
});

describe("shoulder press path and start position", () => {
  const press = getExercise("shoulder_press")!;
  const start = sidePose({ shoulder: 70, elbow: 80 }); // hands at the shoulders
  const lockout = sidePose({ shoulder: 170, elbow: 172 }); // straight up
  const atWaist = sidePose({ shoulder: 15, elbow: 95 }); // hands down by the belt
  const forward = sidePose({ shoulder: 90, elbow: 172 }); // arms straight out in front
  const noHips = (lm: Landmark[]) => lm.map((p, i) => (i === 23 || i === 24 ? { ...p, y: 1.2 } : p)); // seated, hips out of frame

  it("counts a press that goes straight up without any drift warning", () => {
    const r = run(new WorkoutEngine(press), [noHips(start), noHips(lockout), noHips(start)]);
    expect(r.reps.map((e) => e.type)).toEqual(["rep"]);
    expect(r.coached.find((i) => i.id === "press_drift")).toBeUndefined();
  });

  it("doesn't count straight arms held out in front, however straight the elbows get", () => {
    const r = run(new WorkoutEngine(press), [noHips(start), noHips(forward), noHips(start)], { hold: 14 });
    expect(last(r).reps).toBe(0);
    expect(r.reps[0]).toMatchObject({ type: "partial" });
    expect(r.reps[0].faults[0]).toMatchObject({ status: "bad", rule: { id: "hands_not_up" } });
    expect(r.coached.find((i) => i.id === "press_drift")).toMatchObject({ status: "warn" });
  });

  it("doesn't count a press that stops with the hands only at head height", () => {
    const headHigh = sidePose({ shoulder: 130, elbow: 172 });
    const r = run(new WorkoutEngine(press), [noHips(start), noHips(headHigh), noHips(start)]);
    expect(last(r).reps).toBe(0);
  });

  it("doesn't count a press that starts from the waist, and says where to start", () => {
    const r = run(new WorkoutEngine(press), [noHips(atWaist), noHips(lockout), noHips(atWaist)]);
    expect(last(r).reps).toBe(0);
    expect(r.reps[0]).toMatchObject({ type: "partial", noteId: "start", note: expect.stringContaining("shoulder height") });
    expect(r.snaps.find((x) => x.issue?.id === "start")?.issue).toMatchObject({ label: "Start position" });
  });

  it("counts the next rep once you start from the shoulders again", () => {
    const r = run(new WorkoutEngine(press), [noHips(atWaist), noHips(lockout), noHips(start), noHips(lockout), noHips(start)]);
    expect(r.reps.map((e) => e.type)).toEqual(["partial", "rep"]);
  });

  it("doesn't block when the wrist can't be measured at the start", () => {
    const e = new WorkoutEngine(getExercise("bicep_curl")!); // no start_check configured
    expect(run(e, [sidePose({ elbow: 170 }), sidePose({ elbow: 40 }), sidePose({ elbow: 170 })]).reps[0].type).toBe("rep");
  });
});
