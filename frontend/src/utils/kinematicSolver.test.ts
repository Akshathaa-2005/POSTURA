import { describe, expect, it } from "vitest";
import {
  clampAnatomicalRotation,
  distributeSpineFlexion,
  HUMAN_ANATOMICAL_LIMITS,
  solveLandmarksToAvatar,
  springInterpolateQuat,
} from "./kinematicSolver";
import * as THREE from "three";
import type { Landmark } from "@/types/mediapipe";
import { LM } from "@/types/mediapipe";

function createNeutralLandmarks(): Landmark[] {
  const lms: Landmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0.0,
    visibility: 0.95,
  }));

  // Torso
  lms[LM.NOSE] = { x: 0.5, y: 0.15, z: 0.0, visibility: 0.99 };
  lms[LM.LEFT_SHOULDER] = { x: 0.58, y: 0.28, z: 0.0, visibility: 0.98 };
  lms[LM.RIGHT_SHOULDER] = { x: 0.42, y: 0.28, z: 0.0, visibility: 0.98 };
  lms[LM.LEFT_HIP] = { x: 0.55, y: 0.52, z: 0.0, visibility: 0.95 };
  lms[LM.RIGHT_HIP] = { x: 0.45, y: 0.52, z: 0.0, visibility: 0.95 };

  // Arms (hanging down)
  lms[LM.LEFT_ELBOW] = { x: 0.60, y: 0.45, z: 0.0, visibility: 0.95 };
  lms[LM.LEFT_WRIST] = { x: 0.61, y: 0.62, z: 0.0, visibility: 0.95 };
  lms[LM.RIGHT_ELBOW] = { x: 0.40, y: 0.45, z: 0.0, visibility: 0.95 };
  lms[LM.RIGHT_WRIST] = { x: 0.39, y: 0.62, z: 0.0, visibility: 0.95 };

  // Legs (standing straight)
  lms[LM.LEFT_KNEE] = { x: 0.55, y: 0.74, z: 0.0, visibility: 0.95 };
  lms[LM.LEFT_ANKLE] = { x: 0.55, y: 0.96, z: 0.0, visibility: 0.95 };
  lms[LM.RIGHT_KNEE] = { x: 0.45, y: 0.74, z: 0.0, visibility: 0.95 };
  lms[LM.RIGHT_ANKLE] = { x: 0.45, y: 0.96, z: 0.0, visibility: 0.95 };

  return lms;
}

describe("kinematicSolver", () => {
  it("clamps rotations within anatomical limits", () => {
    const clampedKnee = clampAnatomicalRotation("LeftLeg", { x: -20, y: 40, z: -50 });
    expect(clampedKnee.x).toBe(HUMAN_ANATOMICAL_LIMITS.LeftLeg.minX);
    expect(clampedKnee.y).toBe(HUMAN_ANATOMICAL_LIMITS.LeftLeg.maxY);
    expect(clampedKnee.z).toBe(HUMAN_ANATOMICAL_LIMITS.LeftLeg.minZ);
  });

  it("distributes spinal curve across lumbar and thoracic segments", () => {
    const { spinePitch, chestPitch } = distributeSpineFlexion(30);
    expect(spinePitch).toBeCloseTo(18);
    expect(chestPitch).toBeCloseTo(12);
    expect(spinePitch + chestPitch).toBeCloseTo(30);
  });

  it("handles empty or insufficient landmarks gracefully", () => {
    expect(solveLandmarksToAvatar(null)).toBeNull();
    expect(solveLandmarksToAvatar([])).toBeNull();
    expect(solveLandmarksToAvatar(Array(10).fill({ x: 0, y: 0, z: 0 }))).toBeNull();
  });

  it("solves neutral standing pose to valid bone quaternions and hips position", () => {
    const lms = createNeutralLandmarks();
    const result = solveLandmarksToAvatar(lms, true);
    expect(result).not.toBeNull();
    expect(result?.hipsPosition).toBeDefined();
    expect(result?.hipsPosition?.y).toBeCloseTo(0.94, 1);

    expect(result?.boneQuaternions.has("Hips")).toBe(true);
    expect(result?.boneQuaternions.has("Spine")).toBe(true);
    expect(result?.boneQuaternions.has("LeftArm")).toBe(true);
    expect(result?.boneQuaternions.has("RightArm")).toBe(true);
    expect(result?.boneQuaternions.has("LeftUpLeg")).toBe(true);
    expect(result?.boneQuaternions.has("RightUpLeg")).toBe(true);
  });

  it("detects squatting depth and lowers hips position", () => {
    const lms = createNeutralLandmarks();
    // Simulate squat: knees bend, ankles come closer vertically to hips
    lms[LM.LEFT_KNEE] = { x: 0.55, y: 0.65, z: 0.1, visibility: 0.95 };
    lms[LM.LEFT_ANKLE] = { x: 0.55, y: 0.76, z: 0.0, visibility: 0.95 }; // hip-to-ankle height shrunk to 0.24
    lms[LM.RIGHT_KNEE] = { x: 0.45, y: 0.65, z: 0.1, visibility: 0.95 };
    lms[LM.RIGHT_ANKLE] = { x: 0.45, y: 0.76, z: 0.0, visibility: 0.95 };

    const standing = solveLandmarksToAvatar(createNeutralLandmarks(), true);
    const squat = solveLandmarksToAvatar(lms, true);

    expect(squat?.hipsPosition?.y).toBeLessThan(standing!.hipsPosition!.y);
  });

  it("rotates arms when user raises hands overhead", () => {
    const lms = createNeutralLandmarks();
    // Raise hands overhead: wrist and elbow above shoulders
    lms[LM.LEFT_ELBOW] = { x: 0.62, y: 0.18, z: 0.0, visibility: 0.95 };
    lms[LM.LEFT_WRIST] = { x: 0.62, y: 0.05, z: 0.0, visibility: 0.95 };

    const standing = solveLandmarksToAvatar(createNeutralLandmarks(), true);
    const raised = solveLandmarksToAvatar(lms, true);

    const standingLeftArm = standing!.boneQuaternions.get("LeftArm")!;
    const raisedLeftArm = raised!.boneQuaternions.get("LeftArm")!;

    // Quaternions should differ significantly when arms are raised overhead
    const angleDiff = standingLeftArm.angleTo(raisedLeftArm);
    expect(angleDiff).toBeGreaterThan(1.0); // > 1 radian (~57 degrees) difference
  });
});
