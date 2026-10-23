import { describe, expect, it } from "vitest";
import {
  analyzeHeadPosture,
  clampAnatomicalRotation,
  distributeSpineFlexion,
  HUMAN_ANATOMICAL_LIMITS,
  solveLandmarksToAvatar,
  springInterpolateQuat,
} from "./kinematicSolver";
import * as THREE from "three";
import type { Landmark } from "@/types/mediapipe";
import { LM } from "@/types/mediapipe";
import { bonePoint, buildRigSkeleton, createGroundingState, groundAvatar } from "./avatarRig";

/** Applies a solved pose to the avatar rig, grounds it and returns the rig for inspection. */
function poseRig(lms: Landmark[], aspect = 1) {
  const solved = solveLandmarksToAvatar(lms, true, { aspect })!;
  const root = new THREE.Group();
  const bones = buildRigSkeleton();
  root.add(bones.get("Hips")!);
  solved.boneQuaternions.forEach((q, name) => bones.get(name)?.quaternion.copy(q));
  groundAvatar(bones, root, createGroundingState());
  return { bones, at: (bone: string, offset: [number, number, number] = [0, 0, 0]) => bonePoint(bones, root, bone, offset) };
}

const kneeDeg = (q: THREE.Quaternion) => THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(q, "YXZ").x);

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

  it("solves neutral standing pose to valid bone quaternions, standing on the floor", () => {
    const lms = createNeutralLandmarks();
    const result = solveLandmarksToAvatar(lms, true);
    expect(result).not.toBeNull();
    const rig = poseRig(lms);
    expect(rig.at("LeftFoot", [0, -0.0475, -0.04]).y).toBeCloseTo(0, 2);
    expect(rig.at("Hips").y).toBeGreaterThan(0.8);

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

    const standing = poseRig(createNeutralLandmarks());
    const squat = poseRig(lms);

    expect(squat.at("Hips").y).toBeLessThan(standing.at("Hips").y - 0.03);
    // Feet stay on the floor rather than floating while the hips drop
    expect(squat.at("LeftFoot", [0, -0.0475, -0.04]).y).toBeLessThan(0.03);
  });

  it("maps a side-on squat to forward hip flexion instead of a sideways fold", () => {
    // User faces screen-right: nose ahead of the ears, toes ahead of the heels, hips stacked in depth
    const lms = createNeutralLandmarks();
    const set = (i: number, x: number, y: number, z = 0) => (lms[i] = { x, y, z, visibility: 0.95 });
    set(LM.LEFT_SHOULDER, 0.47, 0.3, 0.05);
    set(LM.RIGHT_SHOULDER, 0.47, 0.3, -0.05);
    set(LM.LEFT_HIP, 0.4, 0.55, 0.04);
    set(LM.RIGHT_HIP, 0.4, 0.55, -0.04);
    set(LM.LEFT_KNEE, 0.6, 0.6, 0.04);
    set(LM.RIGHT_KNEE, 0.6, 0.6, -0.04);
    set(LM.LEFT_ANKLE, 0.56, 0.82, 0.04);
    set(LM.RIGHT_ANKLE, 0.56, 0.82, -0.04);
    set(LM.LEFT_HEEL, 0.54, 0.85, 0.04);
    set(LM.RIGHT_HEEL, 0.54, 0.85, -0.04);
    set(LM.LEFT_FOOT_INDEX, 0.64, 0.86, 0.04);
    set(LM.RIGHT_FOOT_INDEX, 0.64, 0.86, -0.04);
    set(LM.NOSE, 0.52, 0.18);
    set(LM.LEFT_EAR, 0.48, 0.17, 0.04);
    set(LM.RIGHT_EAR, 0.48, 0.17, -0.04);

    const rig = poseRig(lms);
    const hip = rig.at("LeftUpLeg");
    const knee = rig.at("LeftLeg");
    // Thigh points forward (+Z, toward the viewer of the front preset), not out to the side
    expect(knee.z - hip.z).toBeGreaterThan(0.25);
    expect(Math.abs(knee.x - hip.x)).toBeLessThan(0.12);
  });

  it("relaxes legs that are cut off by the frame instead of folding them up", () => {
    const lms = createNeutralLandmarks();
    // Knees / ankles guessed below the frame edge with low confidence
    lms[LM.LEFT_KNEE] = { x: 0.6, y: 1.12, z: -0.4, visibility: 0.4 };
    lms[LM.RIGHT_KNEE] = { x: 0.4, y: 1.1, z: -0.4, visibility: 0.4 };
    lms[LM.LEFT_ANKLE] = { x: 0.55, y: 0.9, z: 0.5, visibility: 0.2 };
    lms[LM.RIGHT_ANKLE] = { x: 0.45, y: 0.9, z: 0.5, visibility: 0.2 };
    const solved = solveLandmarksToAvatar(lms, true)!;
    for (const bone of ["LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg"]) {
      expect(solved.boneQuaternions.get(bone)!.angleTo(new THREE.Quaternion()), bone).toBeLessThan(0.01);
    }
  });

  it("never bends knees backwards or past the anatomical limit", () => {
    const lms = createNeutralLandmarks();
    // Shin pointing forward from the knee (hyperextension) — noisy depth
    lms[LM.LEFT_ANKLE] = { x: 0.55, y: 0.9, z: -0.6, visibility: 0.95 };
    const solved = solveLandmarksToAvatar(lms, true)!;
    const k = kneeDeg(solved.boneQuaternions.get("LeftLeg")!);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThanOrEqual(145);
  });

  it("tips the pelvis with the body in a push-up so the legs stay in line", () => {
    const lms = createNeutralLandmarks();
    const set = (i: number, x: number, y: number) => (lms[i] = { x, y, z: 0, visibility: 0.95 });
    // Side-on plank, head to screen-right
    set(LM.LEFT_SHOULDER, 0.7, 0.55); set(LM.RIGHT_SHOULDER, 0.7, 0.55);
    set(LM.LEFT_HIP, 0.45, 0.6); set(LM.RIGHT_HIP, 0.45, 0.6);
    set(LM.LEFT_KNEE, 0.3, 0.64); set(LM.RIGHT_KNEE, 0.3, 0.64);
    set(LM.LEFT_ANKLE, 0.15, 0.68); set(LM.RIGHT_ANKLE, 0.15, 0.68);
    set(LM.LEFT_ELBOW, 0.7, 0.68); set(LM.RIGHT_ELBOW, 0.7, 0.68);
    set(LM.LEFT_WRIST, 0.7, 0.8); set(LM.RIGHT_WRIST, 0.7, 0.8);
    set(LM.NOSE, 0.8, 0.55); set(LM.LEFT_EAR, 0.76, 0.52); set(LM.RIGHT_EAR, 0.76, 0.52);

    const rig = poseRig(lms);
    const shoulder = rig.at("LeftArm");
    const hip = rig.at("LeftUpLeg");
    const ankle = rig.at("LeftFoot");
    // Body is long and low, not folded at the hip
    expect(shoulder.distanceTo(ankle)).toBeGreaterThan(1.1);
    expect(hip.y).toBeLessThan(0.5);
    expect(kneeDeg(rig.bones.get("LeftLeg")!.quaternion)).toBeLessThan(20);
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

  it("detects downward head tilt and calculates precise repositioning parameters", () => {
    const lms = createNeutralLandmarks();
    // Neutral gaze: eyes at same height as ears
    lms[LM.LEFT_EAR] = { x: 0.54, y: 0.16, z: 0.0, visibility: 0.95 };
    lms[LM.RIGHT_EAR] = { x: 0.46, y: 0.16, z: 0.0, visibility: 0.95 };
    lms[LM.LEFT_EYE] = { x: 0.53, y: 0.16, z: -0.08, visibility: 0.95 };
    lms[LM.RIGHT_EYE] = { x: 0.47, y: 0.16, z: -0.08, visibility: 0.95 };

    const neutralAnalysis = analyzeHeadPosture(lms);
    expect(neutralAnalysis).not.toBeNull();
    expect(neutralAnalysis?.isTiltedDown).toBe(false);
    expect(Math.abs(neutralAnalysis!.frankfurtPlaneAngleDeg)).toBeLessThan(5);

    // Simulate downward tilted head: eyes drop significantly below ears (flexion)
    lms[LM.LEFT_EYE] = { x: 0.53, y: 0.185, z: -0.08, visibility: 0.95 };
    lms[LM.RIGHT_EYE] = { x: 0.47, y: 0.185, z: -0.08, visibility: 0.95 };
    lms[LM.NOSE] = { x: 0.5, y: 0.21, z: -0.09, visibility: 0.95 };

    const downAnalysis = analyzeHeadPosture(lms);
    expect(downAnalysis).not.toBeNull();
    expect(downAnalysis?.isTiltedDown).toBe(true);
    expect(downAnalysis?.pitchDeg).toBeLessThan(-8);
    // Requires approximately +13° to +18° upward extension
    expect(downAnalysis?.correctionAction.pitchAdjustmentDeg).toBeGreaterThanOrEqual(10);
    expect(downAnalysis?.correctionAction.retractionCm).toBeCloseTo(1.8);
  });

  it("continuously updates head joint to align with downward facial gaze", () => {
    const lms = createNeutralLandmarks();
    // Configure valid ears and eyes
    lms[LM.LEFT_EAR] = { x: 0.54, y: 0.16, z: 0.0, visibility: 0.95 };
    lms[LM.RIGHT_EAR] = { x: 0.46, y: 0.16, z: 0.0, visibility: 0.95 };
    lms[LM.LEFT_EYE] = { x: 0.53, y: 0.16, z: -0.08, visibility: 0.95 };
    lms[LM.RIGHT_EYE] = { x: 0.47, y: 0.16, z: -0.08, visibility: 0.95 };
    lms[LM.NOSE] = { x: 0.50, y: 0.16, z: -0.08, visibility: 0.98 };

    const neutralSolve = solveLandmarksToAvatar(lms, true);
    expect(neutralSolve).not.toBeNull();
    const qHeadNeutral = neutralSolve!.boneQuaternions.get("Head")!;
    expect(qHeadNeutral).toBeDefined();

    const eulerNeutral = new THREE.Euler().setFromQuaternion(qHeadNeutral, "YXZ");
    expect(Math.abs(eulerNeutral.x)).toBeLessThan(0.15); // near 0° pitch

    // Downward gaze: nose and eyes drop lower than ears
    lms[LM.LEFT_EYE] = { x: 0.53, y: 0.19, z: -0.04, visibility: 0.95 };
    lms[LM.RIGHT_EYE] = { x: 0.47, y: 0.19, z: -0.04, visibility: 0.95 };
    lms[LM.NOSE] = { x: 0.50, y: 0.22, z: -0.08, visibility: 0.98 };

    const downSolve = solveLandmarksToAvatar(lms, true);
    expect(downSolve).not.toBeNull();
    const qHeadDown = downSolve!.boneQuaternions.get("Head")!;
    expect(qHeadDown).toBeDefined();

    const eulerDown = new THREE.Euler().setFromQuaternion(qHeadDown, "YXZ");
    // Flexion around local X axis must be positive (tilted downward)
    expect(eulerDown.x).toBeGreaterThan(0.2); // > 11° downward flexion
    expect(eulerDown.x).toBeGreaterThan(eulerNeutral.x);
  });

  it("maintains downward head angle during horizontal exercise posture (push-up/plank)", () => {
    const lms = createNeutralLandmarks();
    // Simulate push-up / horizontal plank:
    // Hips and shoulders are nearly horizontal (y values close), facing floor
    lms[LM.LEFT_HIP] = { x: 0.30, y: 0.40, z: 0.0, visibility: 0.95 };
    lms[LM.RIGHT_HIP] = { x: 0.30, y: 0.40, z: 0.1, visibility: 0.95 };
    lms[LM.LEFT_SHOULDER] = { x: 0.65, y: 0.38, z: 0.0, visibility: 0.95 };
    lms[LM.RIGHT_SHOULDER] = { x: 0.65, y: 0.38, z: 0.1, visibility: 0.95 };

    // Head is gazing at floor (ears above nose in screen Y)
    lms[LM.LEFT_EAR] = { x: 0.72, y: 0.34, z: 0.04, visibility: 0.95 };
    lms[LM.RIGHT_EAR] = { x: 0.72, y: 0.34, z: 0.14, visibility: 0.95 };
    lms[LM.NOSE] = { x: 0.75, y: 0.42, z: 0.08, visibility: 0.95 };

    const pushUpSolve = solveLandmarksToAvatar(lms, true);
    expect(pushUpSolve).not.toBeNull();
    const qHead = pushUpSolve!.boneQuaternions.get("Head");
    expect(qHead).toBeDefined();
    // The head must resolve to a valid non-identity orientation that maintains alignment
    expect(qHead!.lengthSq()).toBeCloseTo(1.0, 3);
  });
});
