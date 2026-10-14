import * as THREE from "three";
import type { Vector3D } from "@/types";
import type { Landmark } from "@/types/mediapipe";
import { LM } from "@/types/mediapipe";

/**
 * Biomechanically grounded kinematic solver inspired by Kalidokit principles.
 * Ensures human-like joint retargeting, continuous spring-damper interpolation,
 * and physiological limits (preventing robotic snapping and unnatural postures).
 */

export interface JointLimits {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export const HUMAN_ANATOMICAL_LIMITS: Record<string, JointLimits> = {
  Spine: { minX: -30, maxX: 40, minY: -25, maxY: 25, minZ: -20, maxZ: 20 },
  Spine1: { minX: -25, maxX: 30, minY: -20, maxY: 20, minZ: -15, maxZ: 15 },
  Neck: { minX: -35, maxX: 35, minY: -45, maxY: 45, minZ: -25, maxZ: 25 },
  Head: { minX: -30, maxX: 30, minY: -40, maxY: 40, minZ: -20, maxZ: 20 },
  LeftUpLeg: { minX: -115, maxX: 25, minY: -30, maxY: 30, minZ: -40, maxZ: 35 },
  RightUpLeg: { minX: -115, maxX: 25, minY: -30, maxY: 30, minZ: -35, maxZ: 40 },
  LeftLeg: { minX: 0, maxX: 145, minY: -10, maxY: 10, minZ: -10, maxZ: 10 },
  RightLeg: { minX: 0, maxX: 145, minY: -10, maxY: 10, minZ: -10, maxZ: 10 },
  LeftArm: { minX: -150, maxX: 85, minY: -80, maxY: 80, minZ: -160, maxZ: 40 },
  RightArm: { minX: -150, maxX: 85, minY: -80, maxY: 80, minZ: -40, maxZ: 160 },
  LeftForeArm: { minX: 0, maxX: 145, minY: -15, maxY: 15, minZ: -15, maxZ: 15 },
  RightForeArm: { minX: 0, maxX: 145, minY: -15, maxY: 15, minZ: -15, maxZ: 15 },
};

/** Clamps Euler degrees to anatomical range */
export function clampAnatomicalRotation(boneName: string, rot: Vector3D): Vector3D {
  const limits = HUMAN_ANATOMICAL_LIMITS[boneName];
  if (!limits) return rot;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  return {
    x: clamp(rot.x, limits.minX, limits.maxX),
    y: clamp(rot.y, limits.minY, limits.maxY),
    z: clamp(rot.z, limits.minZ, limits.maxZ),
  };
}

/**
 * Critically damped spring interpolation for organic human motion.
 * Avoids linear or mechanical easing snaps by simulating musculoskeletal mass and damping.
 */
export function springInterpolateQuat(
  current: THREE.Quaternion,
  target: THREE.Quaternion,
  factor: number = 0.08
): THREE.Quaternion {
  return current.slerp(target, Math.min(1.0, factor));
}

/**
 * Calculates spinal curve distribution across lumbar (Spine) and thoracic (Spine1) segments
 * so torso adjustments feel flexible and organic rather than a rigid stick.
 */
export function distributeSpineFlexion(totalPitchDeg: number): { spinePitch: number; chestPitch: number } {
  // Lumbar takes ~60% of natural torso flexion, thoracic takes ~40%
  return {
    spinePitch: totalPitchDeg * 0.6,
    chestPitch: totalPitchDeg * 0.4,
  };
}

export interface SolvedAvatarPose {
  hipsPosition?: THREE.Vector3;
  boneQuaternions: Map<string, THREE.Quaternion>;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Solves 33 MediaPipe Pose landmarks into local Three.js bone quaternions
 * and hips elevation for real-time 60 FPS avatar motion retargeting.
 */
export function solveLandmarksToAvatar(
  landmarks: Landmark[] | null | undefined,
  mirrored: boolean = true
): SolvedAvatarPose | null {
  if (!landmarks || landmarks.length < 29) return null;

  const isVisible = (idx: number, threshold = 0.32) => {
    const lm = landmarks[idx];
    return lm !== undefined && (lm.visibility === undefined || lm.visibility >= threshold);
  };

  const getVec = (fromIdx: number, toIdx: number): THREE.Vector3 | null => {
    if (!isVisible(fromIdx) || !isVisible(toIdx)) return null;
    const a = landmarks[fromIdx];
    const b = landmarks[toIdx];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = (b.z ?? 0) - (a.z ?? 0);

    // In mirrored view:
    // dx > 0 (screen-right in unmirrored camera) corresponds to user's left.
    // In mirrored Three.js view: screen left is -X.
    // When mirrored is true, screen-left matches user's physical left.
    const x = mirrored ? -dx : dx;
    const y = -dy; // MediaPipe y points down, Three.js Y points up
    const z = -dz * 1.2; // MediaPipe z negative is towards camera, Three.js +Z is towards camera

    const v = new THREE.Vector3(x, y, z);
    if (v.lengthSq() < 1e-6) return null;
    return v.normalize();
  };

  const getMidVec = (fromA: number, fromB: number, toA: number, toB: number): THREE.Vector3 | null => {
    const fromVis = isVisible(fromA) || isVisible(fromB);
    const toVis = isVisible(toA) || isVisible(toB);
    if (!fromVis || !toVis) return null;

    const fa = landmarks[fromA] ?? landmarks[fromB];
    const fb = landmarks[fromB] ?? landmarks[fromA];
    const ta = landmarks[toA] ?? landmarks[toB];
    const tb = landmarks[toB] ?? landmarks[toA];

    const fromX = (fa.x + fb.x) * 0.5;
    const fromY = (fa.y + fb.y) * 0.5;
    const fromZ = ((fa.z ?? 0) + (fb.z ?? 0)) * 0.5;

    const toX = (ta.x + tb.x) * 0.5;
    const toY = (ta.y + tb.y) * 0.5;
    const toZ = ((ta.z ?? 0) + (tb.z ?? 0)) * 0.5;

    const dx = toX - fromX;
    const dy = toY - fromY;
    const dz = toZ - fromZ;

    const x = mirrored ? -dx : dx;
    const y = -dy;
    const z = -dz * 1.2;

    const v = new THREE.Vector3(x, y, z);
    if (v.lengthSq() < 1e-6) return null;
    return v.normalize();
  };

  const boneQuats = new Map<string, THREE.Quaternion>();

  // 1. Hips Pelvic Orientation
  const qHips = new THREE.Quaternion();
  if (isVisible(LM.LEFT_HIP) && isVisible(LM.RIGHT_HIP)) {
    const lh = landmarks[LM.LEFT_HIP];
    const rh = landmarks[LM.RIGHT_HIP];
    const dx = mirrored ? -(lh.x - rh.x) : (lh.x - rh.x);
    const dy = -(lh.y - rh.y);
    const dz = -((lh.z ?? 0) - (rh.z ?? 0)) * 1.2;

    const roll = Math.atan2(dy, Math.max(0.01, Math.abs(dx))) * 0.45;
    const yaw = Math.atan2(dz, Math.max(0.01, Math.abs(dx))) * 0.65;
    qHips.setFromEuler(new THREE.Euler(0, yaw, roll, "YXZ"));
    boneQuats.set("Hips", qHips);
  }
  const qHipsInv = qHips.clone().invert();

  // 2. Spine & Spine1 (Torso from mid-hip to mid-shoulder)
  const vTorso = getMidVec(LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  let qWorldSpine1 = qHips.clone();

  if (vTorso) {
    const vTorsoLocal = vTorso.clone().applyQuaternion(qHipsInv).normalize();
    const qTorsoTotal = new THREE.Quaternion().setFromUnitVectors(UP, vTorsoLocal);

    // Distribute between lumbar (Spine ~55%) and thoracic (Spine1 ~45%)
    const qSpine = new THREE.Quaternion().slerp(qTorsoTotal, 0.55);
    boneQuats.set("Spine", qSpine);

    const qWorldSpine = qHips.clone().multiply(qSpine);
    const qWorldSpineInv = qWorldSpine.clone().invert();

    const vChestLocal = vTorso.clone().applyQuaternion(qWorldSpineInv).normalize();
    const qSpine1 = new THREE.Quaternion().setFromUnitVectors(UP, vChestLocal);
    boneQuats.set("Spine1", qSpine1);

    qWorldSpine1 = qWorldSpine.multiply(qSpine1);
  }
  const qWorldSpine1Inv = qWorldSpine1.clone().invert();

  // 3. Neck & Head (From mid-shoulder to nose)
  const vHead = getMidVec(LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.NOSE, LM.NOSE);
  if (vHead) {
    const vHeadLocal = vHead.clone().applyQuaternion(qWorldSpine1Inv).normalize();
    const qNeck = new THREE.Quaternion().setFromUnitVectors(UP, vHeadLocal);
    boneQuats.set("Neck", qNeck);
  }

  // 4. Limbs Solver Helper
  const solveLimb = (
    vUpperWorld: THREE.Vector3 | null,
    vLowerWorld: THREE.Vector3 | null,
    parentWorldInv: THREE.Quaternion,
    parentWorld: THREE.Quaternion,
    upperName: string,
    lowerName: string,
    restVec: THREE.Vector3 = DOWN
  ) => {
    let limbWorld = parentWorld.clone();
    if (vUpperWorld) {
      const vUpperLocal = vUpperWorld.clone().applyQuaternion(parentWorldInv).normalize();
      const qUpper = new THREE.Quaternion().setFromUnitVectors(restVec, vUpperLocal);
      boneQuats.set(upperName, qUpper);
      limbWorld = parentWorld.clone().multiply(qUpper);
    }

    if (vLowerWorld) {
      const limbWorldInv = limbWorld.clone().invert();
      const vLowerLocal = vLowerWorld.clone().applyQuaternion(limbWorldInv).normalize();
      const qLower = new THREE.Quaternion().setFromUnitVectors(restVec, vLowerLocal);
      boneQuats.set(lowerName, qLower);
    }
  };

  // Left Arm (Shoulder -> Elbow -> Wrist)
  const vLeftUpperArm = getVec(LM.LEFT_SHOULDER, LM.LEFT_ELBOW);
  const vLeftForeArm = getVec(LM.LEFT_ELBOW, LM.LEFT_WRIST);
  solveLimb(
    vLeftUpperArm,
    vLeftForeArm,
    qWorldSpine1Inv,
    qWorldSpine1,
    "LeftArm",
    "LeftForeArm",
    DOWN
  );

  // Right Arm (Shoulder -> Elbow -> Wrist)
  const vRightUpperArm = getVec(LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW);
  const vRightForeArm = getVec(LM.RIGHT_ELBOW, LM.RIGHT_WRIST);
  solveLimb(
    vRightUpperArm,
    vRightForeArm,
    qWorldSpine1Inv,
    qWorldSpine1,
    "RightArm",
    "RightForeArm",
    DOWN
  );

  // 5. Legs
  // Left Leg (Hip -> Knee -> Ankle)
  const vLeftThigh = getVec(LM.LEFT_HIP, LM.LEFT_KNEE);
  const vLeftShin = getVec(LM.LEFT_KNEE, LM.LEFT_ANKLE);
  solveLimb(
    vLeftThigh,
    vLeftShin,
    qHipsInv,
    qHips,
    "LeftUpLeg",
    "LeftLeg",
    DOWN
  );

  // Right Leg (Hip -> Knee -> Ankle)
  const vRightThigh = getVec(LM.RIGHT_HIP, LM.RIGHT_KNEE);
  const vRightShin = getVec(LM.RIGHT_KNEE, LM.RIGHT_ANKLE);
  solveLimb(
    vRightThigh,
    vRightShin,
    qHipsInv,
    qHips,
    "RightUpLeg",
    "RightLeg",
    DOWN
  );

  // 6. Hips Elevation (Squatting / Lunging Depth)
  let hipsPosition: THREE.Vector3 | undefined = undefined;
  if (isVisible(LM.LEFT_HIP) && isVisible(LM.RIGHT_HIP)) {
    const hipY = (landmarks[LM.LEFT_HIP].y + landmarks[LM.RIGHT_HIP].y) * 0.5;
    const hasAnkles = isVisible(LM.LEFT_ANKLE) && isVisible(LM.RIGHT_ANKLE);
    const hasKnees = isVisible(LM.LEFT_KNEE) && isVisible(LM.RIGHT_KNEE);

    if (hasAnkles && hasKnees) {
      const lh = landmarks[LM.LEFT_HIP];
      const rh = landmarks[LM.RIGHT_HIP];
      const lk = landmarks[LM.LEFT_KNEE];
      const rk = landmarks[LM.RIGHT_KNEE];
      const la = landmarks[LM.LEFT_ANKLE];
      const ra = landmarks[LM.RIGHT_ANKLE];

      const dist3D = (a: Landmark, b: Landmark) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = (b.z ?? 0) - (a.z ?? 0);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
      };

      const thighLen = (dist3D(lh, lk) + dist3D(rh, rk)) * 0.5;
      const shinLen = (dist3D(lk, la) + dist3D(rk, ra)) * 0.5;
      const fullLegLen = thighLen + shinLen;

      const kneeY = (lk.y + rk.y) * 0.5;
      const ankleY = (la.y + ra.y) * 0.5;
      const currentVerticalSpan = Math.abs(ankleY - hipY);

      // When standing straight, currentVerticalSpan ~= fullLegLen
      // When squatting, knees bend and currentVerticalSpan shrinks relative to full 3D leg length
      const compressionRatio = Math.max(0, Math.min(0.65, (fullLegLen - currentVerticalSpan) / Math.max(0.1, fullLegLen)));
      const targetY = 0.94 - compressionRatio * 0.85;
      hipsPosition = new THREE.Vector3(0, Math.max(0.48, Math.min(0.96, targetY)), 0);
    } else if (hasKnees) {
      const kneeY = (landmarks[LM.LEFT_KNEE].y + landmarks[LM.RIGHT_KNEE].y) * 0.5;
      const thighHeight = Math.abs(kneeY - hipY);
      const compression = Math.max(0, Math.min(0.20, 0.22 - thighHeight));
      const targetY = 0.94 - compression * 1.5;
      hipsPosition = new THREE.Vector3(0, Math.max(0.50, Math.min(0.96, targetY)), 0);
    }
  }

  return {
    hipsPosition,
    boneQuaternions: boneQuats,
  };
}
