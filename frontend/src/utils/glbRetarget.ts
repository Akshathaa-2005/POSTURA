import * as THREE from "three";
import { RIG_BONES } from "./avatarRig";

/**
 * Drives a skinned glTF (.glb) character from the logical rig built by `buildRigSkeleton`.
 *
 * The logical rig keeps owning all motion (live mimicry, coach tweens, floor contact). Every frame
 * `update()` copies its world-space rotation *change* onto the matching glb bone, so the glb's own
 * rest pose (T-pose, A-pose, any bone axes) doesn't matter.
 *
 * At bind time each limb bone is also swung so it points where the logical rig's limb points
 * (arms down, legs down), which is what makes a T-pose Mixamo/Blender export land in the same
 * stance the pose solver assumes.
 *
 * Bone names: the glb armature must use the names in RIG_BONES (Hips, Spine, Spine1, Neck, Head,
 * LeftUpLeg, LeftLeg, LeftFoot, LeftArm, LeftForeArm, and the Right* equivalents). A `mixamorig:`
 * prefix is accepted. Optional `LeftHand` / `RightHand` bones improve forearm alignment.
 */

/** Bone each logical bone should point at, in the logical rig. ForeArm has no child there (points down). */
const PROXY_CHILD: Record<string, string> = {
  Hips: "Spine",
  Spine: "Spine1",
  Spine1: "Neck",
  Neck: "Head",
  LeftUpLeg: "LeftLeg",
  LeftLeg: "LeftFoot",
  RightUpLeg: "RightLeg",
  RightLeg: "RightFoot",
  LeftArm: "LeftForeArm",
  RightArm: "RightForeArm",
};

/** Bone each glb bone is aimed along when aligning; ForeArm uses the hand when the model has one. */
const GLB_CHILD: Record<string, string> = {
  ...PROXY_CHILD,
  LeftForeArm: "LeftHand",
  RightForeArm: "RightHand",
};

const EXTRA_BONES = ["LeftHand", "RightHand"];

/** `mixamorig:Hips`, `mixamorigHips` (GLTFLoader strips the colon) and `Hips` all become `Hips`. */
export function normalizeBoneName(name: string): string {
  return name.replace(/^mixamorig:?/i, "");
}

/** Finds the glb objects that correspond to the logical rig bones (plus optional hands). */
export function findGlbBones(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const wanted = new Map<string, string>();
  for (const spec of RIG_BONES) wanted.set(spec.name.toLowerCase(), spec.name);
  for (const n of EXTRA_BONES) wanted.set(n.toLowerCase(), n);

  const found = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    const key = wanted.get(normalizeBoneName(o.name).toLowerCase());
    // Keep the first match: Blender sometimes leaves a same-named mesh/empty below the bone.
    if (key && !found.has(key)) found.set(key, o);
  });
  return found;
}

/** Rig bone names that are missing from the glb, for a readable load-time warning. */
export function missingRigBones(glbBones: Map<string, THREE.Object3D>): string[] {
  return RIG_BONES.map((b) => b.name).filter((n) => !glbBones.has(n));
}

export interface GlbRetargeter {
  /** Bones that are actually driven. */
  mapped: string[];
  /** Copy the logical rig's current pose onto the glb. Call once per frame after the rig is posed. */
  update(): void;
}

interface Entry {
  proxy: THREE.Object3D;
  glb: THREE.Object3D;
  /** inverse of the logical bone's bind orientation, in `space` coordinates */
  proxyBindInv: THREE.Quaternion;
  /** glb bone's bind orientation, in `space` coordinates */
  glbBind: THREE.Quaternion;
  /** world-space swing that points the glb bone along the logical bone's bind direction */
  align: THREE.Quaternion;
}

/**
 * Call with both rigs in their bind pose (logical rig on the floor, glb freshly loaded and added
 * under `space`). `space` is the shared parent (the orbit group), so camera orbiting is harmless.
 */
export function createGlbRetargeter(
  proxy: Map<string, THREE.Object3D>,
  glbBones: Map<string, THREE.Object3D>,
  space: THREE.Object3D
): GlbRetargeter {
  const tmpQ = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();
  const spaceInv = new THREE.Quaternion();

  const refreshSpace = () => {
    space.updateMatrixWorld(true);
    space.getWorldQuaternion(spaceInv).invert();
  };
  const quatIn = (o: THREE.Object3D, out = new THREE.Quaternion()) =>
    out.copy(spaceInv).multiply(o.getWorldQuaternion(tmpQ));
  const posIn = (o: THREE.Object3D) => space.worldToLocal(o.getWorldPosition(new THREE.Vector3()));

  refreshSpace();
  const entries: Entry[] = [];

  for (const { name } of RIG_BONES) {
    const p = proxy.get(name);
    const g = glbBones.get(name);
    if (!p || !g) continue;

    const proxyBind = quatIn(p);
    const glbBind = quatIn(g);

    let proxyDir: THREE.Vector3 | null = null;
    const proxyChild = PROXY_CHILD[name] && proxy.get(PROXY_CHILD[name]);
    if (proxyChild) proxyDir = posIn(proxyChild).sub(posIn(p));
    else if (name.endsWith("ForeArm")) proxyDir = new THREE.Vector3(0, -1, 0).applyQuaternion(proxyBind);

    const glbChild = GLB_CHILD[name] ? glbBones.get(GLB_CHILD[name]) : undefined;
    const glbDir = glbChild ? posIn(glbChild).sub(posIn(g)) : null;

    const align = new THREE.Quaternion();
    if (proxyDir && glbDir && proxyDir.lengthSq() > 1e-12 && glbDir.lengthSq() > 1e-12) {
      align.setFromUnitVectors(glbDir.normalize(), proxyDir.normalize());
    }

    entries.push({ proxy: p, glb: g, proxyBindInv: proxyBind.clone().invert(), glbBind, align });
  }

  const target = new THREE.Quaternion();
  const parentQ = new THREE.Quaternion();

  return {
    mapped: entries.map((e) => e.glb.name),
    update() {
      refreshSpace();
      for (const e of entries) {
        // Rotation change of the logical bone since bind, applied on top of the aligned glb bind pose
        quatIn(e.proxy, target).multiply(e.proxyBindInv).multiply(e.align).multiply(e.glbBind);

        if (e.proxy === proxy.get("Hips")) {
          e.proxy.getWorldPosition(tmpV);
          e.glb.parent?.worldToLocal(tmpV);
          e.glb.position.copy(tmpV);
        }

        // Parents are processed first, and getWorldQuaternion refreshes their (changed) matrices
        if (e.glb.parent) quatIn(e.glb.parent, parentQ).invert();
        else parentQ.identity();
        e.glb.quaternion.copy(parentQ).multiply(target);
      }
    },
  };
}

/** Uniform scale that makes the glb's hips-above-floor height match the logical rig's. */
export function fitScaleToRig(model: THREE.Object3D, glbHips: THREE.Object3D, rigHipsHeight: number): number {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const hipsHeight = glbHips.getWorldPosition(new THREE.Vector3()).y - box.min.y;
  return hipsHeight > 1e-6 ? rigHipsHeight / hipsHeight : 1;
}
