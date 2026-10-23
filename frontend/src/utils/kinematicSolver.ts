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
  Neck: { minX: -35, maxX: 45, minY: -45, maxY: 45, minZ: -25, maxZ: 25 },
  Head: { minX: -40, maxX: 55, minY: -45, maxY: 45, minZ: -25, maxZ: 25 },
  LeftUpLeg: { minX: -130, maxX: 30, minY: -30, maxY: 30, minZ: -50, maxZ: 35 },
  RightUpLeg: { minX: -130, maxX: 30, minY: -30, maxY: 30, minZ: -35, maxZ: 50 },
  // Knees flex with positive X (shin swings back)
  LeftLeg: { minX: 0, maxX: 145, minY: -10, maxY: 10, minZ: -10, maxZ: 10 },
  RightLeg: { minX: 0, maxX: 145, minY: -10, maxY: 10, minZ: -10, maxZ: 10 },
  LeftArm: { minX: -180, maxX: 85, minY: -95, maxY: 95, minZ: -170, maxZ: 40 },
  RightArm: { minX: -180, maxX: 85, minY: -95, maxY: 95, minZ: -40, maxZ: 170 },
  // Elbows flex with negative X (forearm swings forward)
  LeftForeArm: { minX: -145, maxX: 5, minY: -15, maxY: 15, minZ: -15, maxZ: 15 },
  RightForeArm: { minX: -145, maxX: 5, minY: -15, maxY: 15, minZ: -15, maxZ: 15 },
  LeftFoot: { minX: -35, maxX: 60, minY: -35, maxY: 35, minZ: -40, maxZ: 40 },
  RightFoot: { minX: -35, maxX: 60, minY: -35, maxY: 35, minZ: -40, maxZ: 40 },
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
  boneQuaternions: Map<string, THREE.Quaternion>;
  /** User's facing direction around the vertical axis (radians, 0 = facing the camera). Removed from the pose. */
  headingRad: number;
}

export interface SolveOptions {
  /** Video width / height. Normalized landmark x is divided by width and y by height. */
  aspect?: number;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
/** MediaPipe's monocular depth is noisy; trust it at well under face value. */
const DEPTH_SCALE = 0.6;
/** Limbs need confident, in-frame landmarks; low-visibility guesses at the frame edge fold the legs up. */
const LIMB_VISIBILITY = 0.5;
const ARM_REST_ABDUCTION_DEG = 8;

function clampQuat(boneName: string, q: THREE.Quaternion): THREE.Quaternion {
  const e = new THREE.Euler().setFromQuaternion(q, "YXZ");
  const c = clampAnatomicalRotation(boneName, {
    x: THREE.MathUtils.radToDeg(e.x),
    y: THREE.MathUtils.radToDeg(e.y),
    z: THREE.MathUtils.radToDeg(e.z),
  });
  return q.setFromEuler(
    new THREE.Euler(THREE.MathUtils.degToRad(c.x), THREE.MathUtils.degToRad(c.y), THREE.MathUtils.degToRad(c.z), "YXZ")
  );
}

/**
 * Solves 33 MediaPipe Pose landmarks into local Three.js bone quaternions for real-time
 * avatar retargeting. The user's heading is factored out so the avatar always faces +Z:
 * a side-on squat becomes a forward pitch (seen correctly from the "Side" camera) instead
 * of a sideways fold. Floor placement is left to the renderer's ground-contact pass.
 */
export function solveLandmarksToAvatar(
  landmarks: Landmark[] | null | undefined,
  mirrored: boolean = true,
  { aspect = 1 }: SolveOptions = {}
): SolvedAvatarPose | null {
  if (!landmarks || landmarks.length < 29) return null;

  const isVisible = (idx: number, threshold = 0.32) => {
    const lm = landmarks[idx];
    return lm !== undefined && (lm.visibility === undefined || lm.visibility >= threshold);
  };
  const isTracked = (idx: number) => {
    const lm = landmarks[idx];
    return isVisible(idx, LIMB_VISIBILITY) && lm.x > -0.05 && lm.x < 1.05 && lm.y > -0.05 && lm.y < 1.05;
  };

  let yawInv = new THREE.Quaternion();

  // Camera deltas → avatar space: mirrored x, Y up, +Z towards the camera, equal units on every axis.
  const toAvatar = (dx: number, dy: number, dz: number, removeHeading = true): THREE.Vector3 | null => {
    const v = new THREE.Vector3((mirrored ? -dx : dx) * aspect, -dy, -dz * aspect * DEPTH_SCALE);
    if (v.lengthSq() < 1e-8) return null;
    v.normalize();
    return removeHeading ? v.applyQuaternion(yawInv) : v;
  };

  const getVec = (fromIdx: number, toIdx: number, removeHeading = true): THREE.Vector3 | null => {
    if (!isVisible(fromIdx) || !isVisible(toIdx)) return null;
    const a = landmarks[fromIdx];
    const b = landmarks[toIdx];
    return toAvatar(b.x - a.x, b.y - a.y, (b.z ?? 0) - (a.z ?? 0), removeHeading);
  };

  const mid = (a: number, b: number) => {
    const la = landmarks[isVisible(a) ? a : b];
    const lb = landmarks[isVisible(b) ? b : a];
    return { x: (la.x + lb.x) * 0.5, y: (la.y + lb.y) * 0.5, z: ((la.z ?? 0) + (lb.z ?? 0)) * 0.5 };
  };

  const getMidVec = (fromA: number, fromB: number, toA: number, toB: number): THREE.Vector3 | null => {
    if (!(isVisible(fromA) || isVisible(fromB)) || !(isVisible(toA) || isVisible(toB))) return null;
    const f = mid(fromA, fromB);
    const t = mid(toA, toB);
    return toAvatar(t.x - f.x, t.y - f.y, t.z - f.z);
  };

  // 0. Heading: hips line (reliable facing the camera) blended with nose / toe direction (reliable side-on)
  let headingRad = 0;
  const vHipLine = isVisible(LM.LEFT_HIP) && isVisible(LM.RIGHT_HIP) ? getVec(LM.LEFT_HIP, LM.RIGHT_HIP, false) : null;
  const faceFwd = new THREE.Vector2();
  const addForward = (from: number, to: number, weight: number) => {
    const v = isVisible(from, 0.5) && isVisible(to, 0.5) ? getVec(from, to, false) : null;
    if (v) faceFwd.add(new THREE.Vector2(v.x, v.z).multiplyScalar(weight));
  };
  addForward(LM.LEFT_HEEL, LM.LEFT_FOOT_INDEX, 1);
  addForward(LM.RIGHT_HEEL, LM.RIGHT_FOOT_INDEX, 1);
  if (isVisible(LM.NOSE, 0.5) && (isVisible(LM.LEFT_EAR, 0.5) || isVisible(LM.RIGHT_EAR, 0.5))) {
    const ears = mid(LM.LEFT_EAR, LM.RIGHT_EAR);
    const n = landmarks[LM.NOSE];
    const v = toAvatar(n.x - ears.x, n.y - ears.y, (n.z ?? 0) - ears.z, false);
    if (v) faceFwd.add(new THREE.Vector2(v.x, v.z).multiplyScalar(1.5));
  }
  if (vHipLine) {
    const lat = new THREE.Vector2(vHipLine.x, vHipLine.z);
    const frontal = THREE.MathUtils.clamp((Math.abs(vHipLine.x) - 0.3) / 0.4, 0, 1);
    const fromHips = new THREE.Vector2(-lat.y, lat.x).normalize(); // forward = up × right
    // Depth ordering of the hips is unreliable when side-on; let the face / toes pick the sign there.
    if (frontal < 0.5 && faceFwd.lengthSq() > 1e-4 && fromHips.dot(faceFwd) < 0) fromHips.negate();
    const fwd = fromHips.multiplyScalar(frontal).add(
      faceFwd.lengthSq() > 1e-4 ? faceFwd.clone().normalize().multiplyScalar(1 - frontal) : new THREE.Vector2()
    );
    if (fwd.lengthSq() > 1e-4) headingRad = Math.atan2(fwd.x, fwd.y);
  } else if (faceFwd.lengthSq() > 1e-4) {
    headingRad = Math.atan2(faceFwd.x, faceFwd.y);
  }
  yawInv = new THREE.Quaternion().setFromAxisAngle(UP, -headingRad);

  const boneQuats = new Map<string, THREE.Quaternion>();

  // 1. Pelvis: tilt bisects torso and thighs so push-ups / bridges tip the whole body, not just the spine
  const vTorso = getMidVec(LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  const kneesTracked = isTracked(LM.LEFT_KNEE) && isTracked(LM.RIGHT_KNEE);
  const vThighs = kneesTracked ? getMidVec(LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_KNEE, LM.RIGHT_KNEE) : null;

  let qHips = new THREE.Quaternion();
  if (vTorso) {
    const pelvisUp = vThighs
      ? vTorso.clone().multiplyScalar(0.6).sub(vThighs.clone().multiplyScalar(0.4))
      : vTorso.clone().multiplyScalar(0.35).add(UP.clone().multiplyScalar(0.65));
    if (pelvisUp.lengthSq() < 1e-3) pelvisUp.copy(vTorso);
    pelvisUp.normalize();

    const hipLine = vHipLine ? vHipLine.clone().applyQuaternion(yawInv) : new THREE.Vector3(1, 0, 0);
    const right = hipLine.sub(pelvisUp.clone().multiplyScalar(hipLine.dot(pelvisUp)));
    if (right.lengthSq() < 1e-3 || right.x < 0.2) {
      // Hips stacked (side-on) — keep the lateral axis level with the camera plane
      right.set(1, 0, 0).sub(pelvisUp.clone().multiplyScalar(pelvisUp.x));
    }
    right.normalize();
    const fwd = new THREE.Vector3().crossVectors(right, pelvisUp).normalize();
    const rightOrtho = new THREE.Vector3().crossVectors(pelvisUp, fwd).normalize();
    qHips = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(rightOrtho, pelvisUp, fwd));
  }
  boneQuats.set("Hips", qHips);
  const qHipsInv = qHips.clone().invert();

  // 2. Spine & Spine1 (Torso from mid-hip to mid-shoulder)
  let qWorldSpine1 = qHips.clone();
  if (vTorso) {
    const vTorsoLocal = vTorso.clone().applyQuaternion(qHipsInv).normalize();
    const qTorsoTotal = new THREE.Quaternion().setFromUnitVectors(UP, vTorsoLocal);

    // Distribute between lumbar (Spine ~55%) and thoracic (Spine1 ~45%)
    const qSpine = clampQuat("Spine", new THREE.Quaternion().slerp(qTorsoTotal, 0.55));
    boneQuats.set("Spine", qSpine);
    const qWorldSpine = qHips.clone().multiply(qSpine);

    const vChestLocal = vTorso.clone().applyQuaternion(qWorldSpine.clone().invert()).normalize();
    const qSpine1 = clampQuat("Spine1", new THREE.Quaternion().setFromUnitVectors(UP, vChestLocal));
    boneQuats.set("Spine1", qSpine1);
    qWorldSpine1 = qWorldSpine.multiply(qSpine1);
  } else {
    boneQuats.set("Spine", new THREE.Quaternion());
    boneQuats.set("Spine1", new THREE.Quaternion());
  }
  const qWorldSpine1Inv = qWorldSpine1.clone().invert();

  // 3. Neck & Head (Continuous 3D facial gaze tracking & downward angle preservation)
  const isVis = (idx: number) => isVisible(idx, 0.25);
  const hasLeftEar = isVis(LM.LEFT_EAR);
  const hasRightEar = isVis(LM.RIGHT_EAR);
  const hasAnyEar = hasLeftEar || hasRightEar;
  const earL = hasLeftEar ? LM.LEFT_EAR : LM.RIGHT_EAR;
  const earR = hasRightEar ? LM.RIGHT_EAR : LM.LEFT_EAR;

  // Validate ears (must sit above shoulders in the camera frame)
  const shY = (landmarks[LM.LEFT_SHOULDER].y + landmarks[LM.RIGHT_SHOULDER].y) * 0.5;
  const earY = hasAnyEar ? ((landmarks[earL]?.y ?? 1) + (landmarks[earR]?.y ?? 1)) * 0.5 : 1.0;
  const earsValid = hasAnyEar && earY < shY;

  // Neck articulates from mid-shoulder to skull base / mid-ear (or nose)
  const vNeck = earsValid
    ? getMidVec(LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, earL, earR)
    : getMidVec(LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.NOSE, LM.NOSE);

  let qWorldNeck = qWorldSpine1.clone();
  if (vNeck) {
    const vNeckLocal = vNeck.clone().applyQuaternion(qWorldSpine1Inv).normalize();
    const qNeck = clampQuat("Neck", new THREE.Quaternion().setFromUnitVectors(UP, vNeckLocal));
    boneQuats.set("Neck", qNeck);
    qWorldNeck = qWorldSpine1.clone().multiply(qNeck);
  }
  const qWorldNeckInv = qWorldNeck.clone().invert();

  // Forward gaze vector: points forward from back of skull / ears to nose / eye plane
  let vFaceForward: THREE.Vector3 | null = null;
  if (earsValid && isVis(LM.NOSE)) {
    vFaceForward = getMidVec(earL, earR, LM.NOSE, LM.NOSE);
  }
  // Fallback gaze when ears are occluded: project forward from neck alignment
  if (!vFaceForward) {
    vFaceForward = new THREE.Vector3(0, 0, 1).applyQuaternion(qWorldNeck);
  }
  // Ensure forward gaze depth is non-zero
  if (Math.abs(vFaceForward.z) < 0.05 && Math.abs(vFaceForward.y) < 0.25) {
    vFaceForward.z = 0.5;
    vFaceForward.normalize();
  }

  // Lateral eye/ear axis (Right vector): from left eye/ear to right eye/ear (+X direction)
  let vFaceRight: THREE.Vector3 | null = null;
  if (isVis(LM.LEFT_EYE) && isVis(LM.RIGHT_EYE)) {
    vFaceRight = getVec(LM.LEFT_EYE, LM.RIGHT_EYE);
  } else if (earsValid) {
    vFaceRight = getVec(earL, earR);
  } else {
    vFaceRight = getVec(LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  }

  let vRightSafe = vFaceRight ? vFaceRight.clone() : new THREE.Vector3(1, 0, 0);
  if (vRightSafe.x < 0) vRightSafe.negate(); // Ensure points to user/model right (+X)
  if (Math.abs(vRightSafe.dot(vFaceForward)) > 0.85) {
    vRightSafe = new THREE.Vector3(1, 0, 0);
    if (Math.abs(vRightSafe.dot(vFaceForward)) > 0.85) {
      vRightSafe = new THREE.Vector3(0, 0, 1);
    }
  }

  // Orthonormal head basis: forward (+Z), up (+Y) = forward × right, right (+X) = up × forward
  const vFaceUp = new THREE.Vector3().crossVectors(vFaceForward, vRightSafe).normalize();
  const vFaceRightOrtho = new THREE.Vector3().crossVectors(vFaceUp, vFaceForward).normalize();

  if (vFaceUp.lengthSq() > 0.5 && vFaceRightOrtho.lengthSq() > 0.5) {
    const mFaceWorld = new THREE.Matrix4().makeBasis(vFaceRightOrtho, vFaceUp, vFaceForward);
    const qFaceWorld = new THREE.Quaternion().setFromRotationMatrix(mFaceWorld);
    boneQuats.set("Head", clampQuat("Head", qWorldNeckInv.clone().multiply(qFaceWorld)));
  } else {
    boneQuats.set("Head", new THREE.Quaternion());
  }

  // 4. Limbs. Untracked segments relax to rest instead of keeping stale or off-frame guesses.
  const restArm = (side: "Left" | "Right") =>
    new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      THREE.MathUtils.degToRad(side === "Left" ? -ARM_REST_ABDUCTION_DEG : ARM_REST_ABDUCTION_DEG)
    );

  const trackedVec = (from: number, to: number) => (isTracked(from) && isTracked(to) ? getVec(from, to) : null);

  const solveArm = (side: "Left" | "Right", shoulder: number, elbow: number, wrist: number) => {
    const upperName = `${side}Arm`;
    const lowerName = `${side}ForeArm`;
    const vUpper = trackedVec(shoulder, elbow);
    const qUpper = vUpper
      ? clampQuat(upperName, new THREE.Quaternion().setFromUnitVectors(DOWN, vUpper.applyQuaternion(qWorldSpine1Inv)))
      : restArm(side);
    boneQuats.set(upperName, qUpper);

    const vLower = vUpper ? trackedVec(elbow, wrist) : null;
    if (!vLower) {
      boneQuats.set(lowerName, new THREE.Quaternion());
      return;
    }
    const limbWorldInv = qWorldSpine1.clone().multiply(qUpper).invert();
    const qLower = new THREE.Quaternion().setFromUnitVectors(DOWN, vLower.applyQuaternion(limbWorldInv));
    // The elbow can't fold past ~145°; keep the bend direction but cap its magnitude.
    const maxBend = THREE.MathUtils.degToRad(145);
    const bend = 2 * Math.acos(Math.min(1, Math.abs(qLower.w)));
    if (bend > maxBend) qLower.slerp(new THREE.Quaternion(), 1 - maxBend / bend);
    boneQuats.set(lowerName, qLower);
  };

  const solveLeg = (side: "Left" | "Right", hip: number, knee: number, ankle: number, heel: number, toe: number) => {
    const upperName = `${side}UpLeg`;
    const vThigh = trackedVec(hip, knee);
    const qUpper = vThigh
      ? clampQuat(upperName, new THREE.Quaternion().setFromUnitVectors(DOWN, vThigh.applyQuaternion(qHipsInv)))
      : new THREE.Quaternion();
    boneQuats.set(upperName, qUpper);
    const qThighWorld = qHips.clone().multiply(qUpper);

    // Knee is a hinge: project the shin onto the thigh's sagittal plane and clamp the flexion.
    const vShin = vThigh ? trackedVec(knee, ankle) : null;
    let kneeDeg = 0;
    if (vShin) {
      const local = vShin.applyQuaternion(qThighWorld.clone().invert());
      kneeDeg = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(Math.atan2(-local.z, -local.y)), 0, 145);
    }
    const qKnee = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(kneeDeg));
    boneQuats.set(`${side}Leg`, qKnee);
    const qShinWorld = qThighWorld.multiply(qKnee);

    // Feet follow heel → toe when visible, otherwise stay flat on the floor.
    const vFoot = vShin ? trackedVec(heel, toe) : null;
    const qFoot = vFoot
      ? new THREE.Quaternion().setFromUnitVectors(FORWARD, vFoot.applyQuaternion(qShinWorld.clone().invert()))
      : qShinWorld.clone().invert();
    boneQuats.set(`${side}Foot`, clampQuat(`${side}Foot`, qFoot));
  };

  solveArm("Left", LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST);
  solveArm("Right", LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST);
  solveLeg("Left", LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE, LM.LEFT_HEEL, LM.LEFT_FOOT_INDEX);
  solveLeg("Right", LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE, LM.RIGHT_HEEL, LM.RIGHT_FOOT_INDEX);

  return { boneQuaternions: boneQuats, headingRad };
}

export interface HeadPostureAnalysis {
  /** Head pitch angle in degrees (negative = tilted down, 0 = neutral horizontal gaze, positive = tilted up) */
  pitchDeg: number;
  /** Whether the head is tilted downward beyond anatomical tolerance (> 8° depression) */
  isTiltedDown: boolean;
  /** Whether forward head translation is detected relative to coronal shoulder line */
  isForwardHead: boolean;
  /** Frankfurt Horizontal Plane angle (0° = parallel to floor) */
  frankfurtPlaneAngleDeg: number;
  /** Specific measurable corrective adjustments to reposition head into neutral alignment */
  correctionAction: {
    pitchAdjustmentDeg: number;
    retractionCm: number;
    thoracicAdjustmentDeg: number;
  };
}

/**
 * Evaluates head tilt and cervical posture from MediaPipe facial and shoulder landmarks.
 * Calculates Frankfurt Horizontal Plane inclination and returns precise repositioning parameters.
 */
export function analyzeHeadPosture(landmarks: Landmark[] | null | undefined): HeadPostureAnalysis | null {
  if (!landmarks || landmarks.length < 13) return null;

  const isVis = (idx: number) => {
    const lm = landmarks[idx];
    return lm !== undefined && (lm.visibility === undefined || lm.visibility >= 0.35);
  };

  const hasNose = isVis(LM.NOSE);
  const hasShoulders = isVis(LM.LEFT_SHOULDER) && isVis(LM.RIGHT_SHOULDER);
  if (!hasNose || !hasShoulders) return null;

  const hasEars = isVis(LM.LEFT_EAR) || isVis(LM.RIGHT_EAR);
  const hasEyes = isVis(LM.LEFT_EYE) || isVis(LM.RIGHT_EYE);

  let frankfurtAngleDeg = 0;
  if (hasEars && hasEyes) {
    const ear = isVis(LM.LEFT_EAR) && isVis(LM.RIGHT_EAR)
      ? {
          y: (landmarks[LM.LEFT_EAR].y + landmarks[LM.RIGHT_EAR].y) * 0.5,
          z: ((landmarks[LM.LEFT_EAR].z ?? 0) + (landmarks[LM.RIGHT_EAR].z ?? 0)) * 0.5,
        }
      : landmarks[isVis(LM.LEFT_EAR) ? LM.LEFT_EAR : LM.RIGHT_EAR];

    const eye = isVis(LM.LEFT_EYE) && isVis(LM.RIGHT_EYE)
      ? {
          y: (landmarks[LM.LEFT_EYE].y + landmarks[LM.RIGHT_EYE].y) * 0.5,
          z: ((landmarks[LM.LEFT_EYE].z ?? 0) + (landmarks[LM.RIGHT_EYE].z ?? 0)) * 0.5,
        }
      : landmarks[isVis(LM.LEFT_EYE) ? LM.LEFT_EYE : LM.RIGHT_EYE];

    const dy = eye.y - ear.y; // positive when eye is below ear (head tilted down)
    const dz = (eye.z ?? 0) - (ear.z ?? 0);
    const span = Math.hypot(dy, Math.max(0.04, Math.abs(dz)));
    frankfurtAngleDeg = THREE.MathUtils.radToDeg(Math.asin(-dy / span));
  } else {
    const shY = (landmarks[LM.LEFT_SHOULDER].y + landmarks[LM.RIGHT_SHOULDER].y) * 0.5;
    const noseY = landmarks[LM.NOSE].y;
    const neckSpan = shY - noseY;
    frankfurtAngleDeg = (neckSpan - 0.16) * 120;
  }

  const pitchDeg = frankfurtAngleDeg;
  const isTiltedDown = pitchDeg < -8.0;

  let isForwardHead = false;
  if (hasEars) {
    const earZ = ((landmarks[LM.LEFT_EAR]?.z ?? 0) + (landmarks[LM.RIGHT_EAR]?.z ?? 0)) * 0.5;
    const shZ = ((landmarks[LM.LEFT_SHOULDER].z ?? 0) + (landmarks[LM.RIGHT_SHOULDER].z ?? 0)) * 0.5;
    isForwardHead = (shZ - earZ) > 0.05;
  }

  return {
    pitchDeg,
    isTiltedDown,
    isForwardHead,
    frankfurtPlaneAngleDeg: frankfurtAngleDeg,
    correctionAction: {
      pitchAdjustmentDeg: isTiltedDown ? Math.round(Math.abs(pitchDeg)) : 0,
      retractionCm: isForwardHead || isTiltedDown ? 1.8 : 0,
      thoracicAdjustmentDeg: isTiltedDown ? -4 : 0,
    },
  };
}
