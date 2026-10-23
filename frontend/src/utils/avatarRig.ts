import * as THREE from "three";
import type { Vector3D } from "@/types";
import { clampAnatomicalRotation } from "./kinematicSolver";

/**
 * Bone hierarchy of the anatomical clay avatar, shared by the renderer, the replay
 * library and the tests so they all agree on segment lengths.
 *
 * Rotation conventions (Euler degrees, "YXZ", relative to the parent bone):
 *   - Limbs rest pointing down. Negative X swings them forward (hip / shoulder flexion).
 *   - Knees flex with positive X (shin swings back); elbows flex with negative X.
 *   - Left limbs abduct with negative Z, right limbs with positive Z.
 *   - Spine / Hips rest pointing up. Positive X tips the trunk forward.
 *   - The avatar faces +Z.
 */
export interface RigBoneSpec {
  name: string;
  parent: string | null;
  offset: [number, number, number];
}

export const RIG_BONES: RigBoneSpec[] = [
  { name: "Hips", parent: null, offset: [0, 0.94, 0] },
  { name: "Spine", parent: "Hips", offset: [0, 0.075, 0] },
  { name: "Spine1", parent: "Spine", offset: [0, 0.12, 0] },
  { name: "Neck", parent: "Spine1", offset: [0, 0.195, 0.005] },
  { name: "Head", parent: "Neck", offset: [0, 0.085, -0.018] },
  { name: "LeftUpLeg", parent: "Hips", offset: [-0.1, -0.05, 0] },
  { name: "LeftLeg", parent: "LeftUpLeg", offset: [0, -0.38, 0] },
  { name: "LeftFoot", parent: "LeftLeg", offset: [0, -0.38, 0] },
  { name: "RightUpLeg", parent: "Hips", offset: [0.1, -0.05, 0] },
  { name: "RightLeg", parent: "RightUpLeg", offset: [0, -0.38, 0] },
  { name: "RightFoot", parent: "RightLeg", offset: [0, -0.38, 0] },
  { name: "LeftArm", parent: "Spine1", offset: [-0.18, 0.17, 0] },
  { name: "LeftForeArm", parent: "LeftArm", offset: [0, -0.26, 0] },
  { name: "RightArm", parent: "Spine1", offset: [0.18, 0.17, 0] },
  { name: "RightForeArm", parent: "RightArm", offset: [0, -0.26, 0] },
];

/** Builds the bare bone hierarchy. The returned "Hips" bone is the root; add it to a scene group. */
export function buildRigSkeleton(): Map<string, THREE.Object3D> {
  const bones = new Map<string, THREE.Object3D>();
  for (const spec of RIG_BONES) {
    const bone = new THREE.Group();
    bone.name = spec.name;
    bone.position.set(...spec.offset);
    if (spec.parent) bones.get(spec.parent)!.add(bone);
    bones.set(spec.name, bone);
  }
  return bones;
}

export function eulerDegToQuaternion(rot: Vector3D, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(rot.x),
      THREE.MathUtils.degToRad(rot.y),
      THREE.MathUtils.degToRad(rot.z),
      "YXZ"
    )
  );
}

/** Snaps every listed bone to its (anatomically clamped) target rotation. */
export function applyPoseRotations(
  bones: Map<string, THREE.Object3D>,
  rotations: Partial<Record<string, Vector3D>>
): void {
  for (const [name, rot] of Object.entries(rotations)) {
    const bone = bones.get(name);
    if (!bone || !rot) continue;
    eulerDegToQuaternion(clampAnatomicalRotation(name, rot), bone.quaternion);
  }
}

// ── Ground contact ──────────────────────────────────────────────────────────

export const FLOOR_Y = 0;
const CONTACT_EPS = 0.02;

/**
 * Spheres approximating the body surface. The lowest one is kept on the floor, and
 * probes marked `lock` (heels, toes, knees, hands) stay planted while they touch it.
 */
export interface ContactProbe {
  bone: string;
  offset: [number, number, number];
  radius: number;
  lock?: boolean;
}

const sidedProbes = (side: "Left" | "Right"): ContactProbe[] => [
  { bone: `${side}Foot`, offset: [0, -0.0475, -0.04], radius: 0, lock: true }, // heel
  { bone: `${side}Foot`, offset: [0, -0.0475, 0.13], radius: 0, lock: true }, // toe
  { bone: `${side}Foot`, offset: [0, 0.0075, 0.13], radius: 0 }, // top of toes (prone)
  { bone: `${side}Leg`, offset: [0, 0, 0.045], radius: 0.015, lock: true }, // kneecap
  { bone: `${side}Leg`, offset: [0, -0.19, 0], radius: 0.05 }, // calf
  { bone: `${side}UpLeg`, offset: [0, -0.18, 0], radius: 0.065 }, // thigh
  { bone: `${side}Arm`, offset: [0, -0.13, 0], radius: 0.042 }, // upper arm
  { bone: `${side}ForeArm`, offset: [0, 0, 0], radius: 0.04 }, // elbow
  { bone: `${side}ForeArm`, offset: [0, -0.27, 0], radius: 0.015, lock: true }, // hand
];

export const CONTACT_PROBES: ContactProbe[] = [
  { bone: "Hips", offset: [0, -0.015, 0], radius: 0.12 },
  { bone: "Spine", offset: [0, 0.06, 0], radius: 0.125 },
  { bone: "Spine1", offset: [0, 0.095, 0], radius: 0.135 },
  { bone: "Head", offset: [0, 0.078, 0], radius: 0.095 },
  ...sidedProbes("Left"),
  ...sidedProbes("Right"),
];

/**
 * How the avatar is held in place horizontally:
 *  - "contacts": every planted heel / toe / knee / hand stays where it landed.
 *  - "LeftFoot" / "RightFoot": only that foot is pinned (e.g. the stepping leg of a lunge moves).
 *  - "hips": the pelvis stays put (supine leg raises).
 */
export type GroundAnchor = "contacts" | "hips" | "LeftFoot" | "RightFoot";

export interface GroundingState {
  locks: Map<number, THREE.Vector2>;
  home: THREE.Vector2;
}

export function createGroundingState(): GroundingState {
  return { locks: new Map(), home: new THREE.Vector2() };
}

function probePoints(bones: Map<string, THREE.Object3D>, root: THREE.Object3D): (THREE.Vector3 | null)[] {
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  return CONTACT_PROBES.map((p) => {
    const bone = bones.get(p.bone);
    if (!bone) return null;
    return new THREE.Vector3(...p.offset).applyMatrix4(bone.matrixWorld).applyMatrix4(rootInv);
  });
}

/**
 * Places the avatar on the floor: the lowest body point touches FLOOR_Y (no floating, no
 * sinking) and planted contacts don't slide. Coordinates are in `root`'s local space, which
 * must be the Hips bone's parent.
 */
export function groundAvatar(
  bones: Map<string, THREE.Object3D>,
  root: THREE.Object3D,
  state: GroundingState,
  anchor: GroundAnchor = "contacts",
  recenterRate = 0
): void {
  const hips = bones.get("Hips");
  if (!hips) return;
  const pts = probePoints(bones, root);

  let minY = Infinity;
  pts.forEach((p, i) => {
    if (p) minY = Math.min(minY, p.y - CONTACT_PROBES[i].radius);
  });
  if (!Number.isFinite(minY)) return;
  const dy = FLOOR_Y - minY;
  hips.position.y += dy;

  if (anchor === "hips") {
    hips.position.x = state.home.x;
    hips.position.z = state.home.y;
    state.locks.clear();
    return;
  }

  const isAnchor = (i: number) => {
    const probe = CONTACT_PROBES[i];
    return probe.lock && (anchor === "contacts" || probe.bone === anchor);
  };
  // A designated pivot foot stays pinned even if it briefly lifts; other contacts lock only while touching
  const pinned = anchor !== "contacts";
  const inContact = (i: number) => pinned || pts[i]!.y + dy - CONTACT_PROBES[i].radius < FLOOR_Y + CONTACT_EPS;

  let sx = 0;
  let sz = 0;
  let n = 0;
  pts.forEach((p, i) => {
    const lock = state.locks.get(i);
    if (!p || !lock || !isAnchor(i) || !inContact(i)) return;
    sx += lock.x - p.x;
    sz += lock.y - p.z;
    n++;
  });
  const dx = n ? sx / n : 0;
  const dz = n ? sz / n : 0;
  hips.position.x += dx;
  hips.position.z += dz;

  // Slowly pull a drifting live-mirrored body back to its home spot (moving the locks with it).
  let rx = 0;
  let rz = 0;
  if (recenterRate > 0) {
    rx = (state.home.x - hips.position.x) * recenterRate;
    rz = (state.home.y - hips.position.z) * recenterRate;
    hips.position.x += rx;
    hips.position.z += rz;
    state.locks.forEach((l) => l.set(l.x + rx, l.y + rz));
  }

  pts.forEach((p, i) => {
    if (!p || !isAnchor(i) || !inContact(i)) {
      state.locks.delete(i);
    } else if (!state.locks.has(i)) {
      state.locks.set(i, new THREE.Vector2(p.x + dx + rx, p.z + dz + rz));
    }
  });
}

/**
 * Moves the avatar so its body is centred over `home` (x, z) and clears contact locks.
 * Call after snapping to a new starting pose, e.g. lying down for a push-up.
 */
export function centerAvatar(
  bones: Map<string, THREE.Object3D>,
  root: THREE.Object3D,
  state: GroundingState,
  home: { x: number; z: number } = { x: 0, z: 0 }
): void {
  const hips = bones.get("Hips");
  if (!hips) return;
  const pts = probePoints(bones, root).filter((p): p is THREE.Vector3 => p !== null);
  const box = new THREE.Box3().setFromPoints(pts);
  const center = box.getCenter(new THREE.Vector3());
  hips.position.x += home.x - center.x;
  hips.position.z += home.z - center.z;
  state.locks.clear();
  state.home.set(hips.position.x, hips.position.z);
}

/** World-space (root-local) position of a point attached to a bone, for tests and debugging. */
export function bonePoint(
  bones: Map<string, THREE.Object3D>,
  root: THREE.Object3D,
  bone: string,
  offset: [number, number, number] = [0, 0, 0]
): THREE.Vector3 {
  root.updateMatrixWorld(true);
  const p = new THREE.Vector3(...offset).applyMatrix4(bones.get(bone)!.matrixWorld);
  return p.applyMatrix4(root.matrixWorld.clone().invert());
}
