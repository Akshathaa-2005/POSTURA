import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildExerciseReplaySequence, EXERCISE_DEMOS } from "./exerciseReplays";
import type { ExerciseReplaySequence } from "./exerciseReplays";
import {
  applyPoseRotations,
  bonePoint,
  buildRigSkeleton,
  centerAvatar,
  createGroundingState,
  eulerDegToQuaternion,
  groundAvatar,
} from "./avatarRig";
import { clampAnatomicalRotation } from "./kinematicSolver";
import { EXERCISES } from "./exercises";
import type { AvatarCommand } from "@/types";

const HEEL: [number, number, number] = [0, -0.0475, -0.04];
const TOE: [number, number, number] = [0, -0.0475, 0.13];
const HAND: [number, number, number] = [0, -0.27, 0];

/** Plays a sequence through the same slerp + ground-contact loop the renderer uses. */
function playSequence(seq: ExerciseReplaySequence) {
  const root = new THREE.Group();
  const bones = buildRigSkeleton();
  root.add(bones.get("Hips")!);
  const state = createGroundingState();
  applyPoseRotations(bones, seq.keyframes[0].boneRotations);
  groundAvatar(bones, root, state, seq.anchor);
  centerAvatar(bones, root, state);
  groundAvatar(bones, root, state, seq.anchor);

  const poses: { hipsY: number; at: (bone: string, offset?: [number, number, number]) => THREE.Vector3 }[] = [];
  const snapshot = () => {
    const points = new Map<string, THREE.Vector3>();
    const at = (bone: string, offset: [number, number, number] = [0, 0, 0]) => {
      const key = `${bone}:${offset.join(",")}`;
      if (!points.has(key)) points.set(key, bonePoint(bones, root, bone, offset));
      return points.get(key)!;
    };
    // Resolve the points we test eagerly, before the pose changes
    for (const side of ["Left", "Right"]) {
      at(`${side}Foot`, HEEL);
      at(`${side}Foot`, TOE);
      at(`${side}ForeArm`, HAND);
      at(`${side}ForeArm`);
      at(`${side}Leg`, [0, 0, 0.045]);
    }
    poses.push({ hipsY: bones.get("Hips")!.position.y, at });
  };
  snapshot();

  let maxSlide = 0;
  for (const kf of seq.keyframes.slice(1)) {
    const start = new Map<string, THREE.Quaternion>();
    bones.forEach((b, n) => start.set(n, b.quaternion.clone()));
    const before = bonePoint(bones, root, "LeftFoot", HEEL);
    for (let step = 1; step <= 30; step++) {
      for (const [name, rot] of Object.entries(kf.boneRotations)) {
        const target = eulerDegToQuaternion(clampAnatomicalRotation(name, rot!));
        bones.get(name)!.quaternion.slerpQuaternions(start.get(name)!, target, step / 30);
      }
      groundAvatar(bones, root, state, seq.anchor);
    }
    const after = bonePoint(bones, root, "LeftFoot", HEEL);
    if (before.y < 0.02 && after.y < 0.02) maxSlide = Math.max(maxSlide, Math.hypot(after.x - before.x, after.z - before.z));
    snapshot();
  }
  return { poses, maxSlide };
}

const sole = (p: ReturnType<typeof playSequence>["poses"][number], side: string) =>
  Math.min(p.at(`${side}Foot`, HEEL).y, p.at(`${side}Foot`, TOE).y);

const FLOOR_EXERCISES = new Set(["push_up", "knee_push_up", "plank", "side_plank", "glute_bridge", "sit_up", "leg_raise"]);

describe("exerciseReplays", () => {
  it("has a coach demo for every exercise in the library", () => {
    for (const ex of EXERCISES) {
      expect(EXERCISE_DEMOS[ex.id], ex.id).toBeDefined();
      const seq = buildExerciseReplaySequence(null, ex.id);
      expect(seq.exerciseId).toBe(ex.id);
      expect(seq.keyframes.map((k) => k.phase)).toEqual(["setup", "movement", "peak", "return"]);
      // Every keyframe fully specifies the pose so repeated replays are identical
      for (const kf of seq.keyframes) expect(Object.keys(kf.boneRotations).length).toBeGreaterThanOrEqual(15);
    }
  });

  it("focuses the demo on every authored fault of every exercise", () => {
    for (const ex of EXERCISES) {
      for (const fault of ex.faults) {
        const cmd: AvatarCommand = { primary_fault: fault.id, verbal_cue: "", highlight_joints: [], avatar_actions: [] };
        const seq = buildExerciseReplaySequence(cmd, ex.id);
        expect(seq.exerciseId, `${ex.id}/${fault.id}`).toBe(ex.id);
        expect(seq.faultId).toBe(fault.id);
        expect(seq.keyframes[1].cue).toBe(fault.cue);
        expect(seq.highlightJoints.length, `${ex.id}/${fault.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the avatar on the floor in every phase — no floating, no sinking", () => {
    for (const ex of EXERCISES) {
      const { poses, maxSlide } = playSequence(buildExerciseReplaySequence(null, ex.id));
      for (const [i, p] of poses.entries()) {
        const lowestFoot = Math.min(sole(p, "Left"), sole(p, "Right"));
        expect(lowestFoot, `${ex.id} phase ${i}`).toBeGreaterThanOrEqual(-0.005);
        if (!FLOOR_EXERCISES.has(ex.id)) {
          // Standing work: a foot carries the body weight
          expect(lowestFoot, `${ex.id} phase ${i}`).toBeLessThan(0.005);
        }
      }
      // Feet are meant to travel in jumps, steps and knee drives
      if (!FLOOR_EXERCISES.has(ex.id) && !["jumping_jack", "lunge", "high_knees"].includes(ex.id)) {
        expect(maxSlide, `${ex.id} planted foot slid`).toBeLessThan(0.06);
      }
    }
  });

  it("puts both feet down for two-footed standing moves", () => {
    for (const id of ["squat", "sumo_squat", "jumping_jack", "hip_hinge", "bent_over_row", "wall_sit", "side_lunge"]) {
      const { poses } = playSequence(buildExerciseReplaySequence(null, id));
      for (const [i, p] of poses.entries()) {
        expect(sole(p, "Left"), `${id} phase ${i}`).toBeLessThan(0.035);
        expect(sole(p, "Right"), `${id} phase ${i}`).toBeLessThan(0.035);
      }
    }
  });

  it("supports floor exercises on the right body parts", () => {
    const touching = (y: number) => y < 0.04;
    const pushUp = playSequence(buildExerciseReplaySequence(null, "push_up")).poses;
    for (const p of pushUp.slice(0, 3)) {
      expect(touching(sole(p, "Left"))).toBe(true);
      expect(touching(p.at("LeftForeArm", HAND).y - 0.015)).toBe(true);
    }
    expect(pushUp[1].hipsY).toBeLessThan(pushUp[0].hipsY);

    const kneePushUp = playSequence(buildExerciseReplaySequence(null, "knee_push_up")).poses;
    for (const p of kneePushUp.slice(0, 3)) {
      expect(touching(p.at("LeftLeg", [0, 0, 0.045]).y - 0.015)).toBe(true);
      expect(touching(p.at("LeftForeArm", HAND).y - 0.015)).toBe(true);
    }

    const plank = playSequence(buildExerciseReplaySequence(null, "plank")).poses[2];
    expect(touching(plank.at("LeftForeArm").y - 0.04)).toBe(true);
    expect(touching(sole(plank, "Left"))).toBe(true);

    const bridge = playSequence(buildExerciseReplaySequence(null, "glute_bridge")).poses;
    expect(touching(sole(bridge[2], "Left"))).toBe(true);
    expect(bridge[2].hipsY).toBeGreaterThan(bridge[0].hipsY + 0.1);
  });

  it("squats to parallel with hips descending", () => {
    const seq = buildExerciseReplaySequence(null, "squat");
    const bottom = seq.keyframes[1].boneRotations;
    expect(bottom.LeftUpLeg!.x).toBeLessThan(-80);
    expect(bottom.LeftLeg!.x).toBeGreaterThan(80);
    const { poses } = playSequence(seq);
    expect(poses[1].hipsY).toBeLessThan(poses[0].hipsY - 0.25);
  });

  it("bends the elbows forward during curls", () => {
    const { poses } = playSequence(buildExerciseReplaySequence(null, "bicep_curl"));
    const wristTop = poses[2].at("LeftForeArm", HAND);
    const elbowTop = poses[2].at("LeftForeArm");
    expect(wristTop.y).toBeGreaterThan(elbowTop.y); // hand above elbow
    expect(wristTop.z).toBeGreaterThan(elbowTop.z); // in front of the body, not behind
  });

  it("builds head repositioning sequence when fault is head_down", () => {
    const cmd: AvatarCommand = {
      primary_fault: "head_down",
      verbal_cue: "Lift your chin and level eyes with horizon.",
      highlight_joints: ["Head", "Neck"],
      avatar_actions: [],
    };
    const seq = buildExerciseReplaySequence(cmd, "squat"); // fault takes precedence
    expect(seq.faultId).toBe("head_down");
    expect(seq.highlightJoints).toContain("Head");
    expect(seq.highlightJoints).toContain("Neck");
    expect(seq.keyframes[0].boneRotations["Head"]!.x).toBeGreaterThan(15);
    expect(seq.keyframes[1].boneRotations["Head"]!.x).toBe(0);
  });

  it("finds the exercise from the fault when no exercise id is given", () => {
    const cmd: AvatarCommand = { primary_fault: "elbow_drift", verbal_cue: "Pin it.", highlight_joints: [], avatar_actions: [] };
    expect(buildExerciseReplaySequence(cmd).exerciseId).toBe("bicep_curl");
  });

  it("generates 4-phase fallback sequence for custom commands", () => {
    const cmd: AvatarCommand = {
      primary_fault: "custom_reach",
      verbal_cue: "Reach further forward.",
      highlight_joints: ["LeftArm"],
      avatar_actions: [
        {
          bone_name: "LeftArm",
          rotation_mode: "relative_offset",
          target_rotation: { x: -45, y: 0, z: 0 },
          duration_ms: 600,
          easing: "easeInOutQuad",
        },
      ],
    };

    const seq = buildExerciseReplaySequence(cmd);
    expect(seq.keyframes.length).toBe(4);
    expect(seq.keyframes[1].boneRotations["LeftArm"]!.x).toBe(-45);
    expect(seq.keyframes[3].phase).toBe("return");
  });
});
