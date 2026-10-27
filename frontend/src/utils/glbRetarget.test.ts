import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildRigSkeleton, groundAvatar, createGroundingState } from "./avatarRig";
import { createGlbRetargeter, findGlbBones, fitScaleToRig, missingRigBones, normalizeBoneName } from "./glbRetarget";

/** A Mixamo-like T-pose skeleton (arms along ±X) under a rotated, scaled armature. */
function buildTPoseGlb(prefix = "mixamorig") {
  const model = new THREE.Group();
  const armature = new THREE.Group();
  armature.rotation.x = -Math.PI / 2; // FBX-style import rotation
  armature.scale.setScalar(0.01);
  model.add(armature);

  const bones = new Map<string, THREE.Bone>();
  const add = (name: string, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const b = new THREE.Bone();
    b.name = prefix + name;
    // armature space is Z-up: (x, y, z) here is (right, forward, up)
    b.position.set(x, y, z);
    parent.add(b);
    bones.set(name, b);
    return b;
  };

  add("Hips", armature, 0, 0, 100);
  add("Spine", bones.get("Hips")!, 0, 0, 10);
  add("Spine1", bones.get("Spine")!, 0, 0, 15);
  add("Spine2", bones.get("Spine1")!, 0, 0, 15);
  add("Neck", bones.get("Spine2")!, 0, 0, 20);
  add("Head", bones.get("Neck")!, 0, 0, 12);
  for (const [side, sx] of [["Left", -1], ["Right", 1]] as const) {
    add(`${side}UpLeg`, bones.get("Hips")!, sx * 10, 0, -5);
    add(`${side}Leg`, bones.get(`${side}UpLeg`)!, 0, 0, -42);
    add(`${side}Foot`, bones.get(`${side}Leg`)!, 0, 0, -42);
    add(`${side}Shoulder`, bones.get("Spine2")!, sx * 5, 0, 15);
    add(`${side}Arm`, bones.get(`${side}Shoulder`)!, sx * 12, 0, 0); // T-pose: sideways
    add(`${side}ForeArm`, bones.get(`${side}Arm`)!, sx * 28, 0, 0);
    add(`${side}Hand`, bones.get(`${side}ForeArm`)!, sx * 25, 0, 0);
  }
  return { model, bones };
}

function setup() {
  const space = new THREE.Group();
  const proxy = buildRigSkeleton();
  space.add(proxy.get("Hips")!);
  groundAvatar(proxy, space, createGroundingState());

  const { model, bones } = buildTPoseGlb();
  space.add(model);
  const glbBones = findGlbBones(model);
  const retarget = createGlbRetargeter(proxy, glbBones, space);
  return { space, proxy, model, bones, glbBones, retarget };
}

const worldPos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
const dir = (a: THREE.Object3D, b: THREE.Object3D) => worldPos(b).sub(worldPos(a)).normalize();

describe("glbRetarget", () => {
  it("normalizes mixamo-style bone names", () => {
    expect(normalizeBoneName("mixamorig:LeftArm")).toBe("LeftArm");
    expect(normalizeBoneName("mixamorigLeftArm")).toBe("LeftArm");
    expect(normalizeBoneName("LeftArm")).toBe("LeftArm");
  });

  it("finds every rig bone, with or without the mixamo prefix", () => {
    for (const prefix of ["mixamorig", ""]) {
      const { model } = buildTPoseGlb(prefix);
      const found = findGlbBones(model);
      expect(missingRigBones(found)).toEqual([]);
      expect(found.has("LeftHand")).toBe(true);
    }
    expect(missingRigBones(findGlbBones(new THREE.Group())).length).toBe(15);
  });

  it("pulls a T-pose into the logical rig's arms-down stance at bind", () => {
    const { proxy, bones, retarget } = setup();
    expect(retarget.mapped.length).toBe(15);
    retarget.update();
    for (const side of ["Left", "Right"]) {
      expect(dir(bones.get(`${side}Arm`)!, bones.get(`${side}ForeArm`)!).y).toBeCloseTo(-1, 3);
      expect(dir(bones.get(`${side}ForeArm`)!, bones.get(`${side}Hand`)!).y).toBeCloseTo(-1, 3);
      expect(dir(bones.get(`${side}UpLeg`)!, bones.get(`${side}Leg`)!).y).toBeCloseTo(-1, 3);
    }
    expect(dir(bones.get("Hips")!, bones.get("Spine")!).y).toBeCloseTo(1, 3);
    expect(worldPos(bones.get("Hips")!).y).toBeCloseTo(worldPos(proxy.get("Hips")!).y, 5);
  });

  it("makes glb limbs follow the logical rig through arbitrary poses", () => {
    const { space, proxy, bones, retarget } = setup();
    proxy.get("LeftArm")!.quaternion.setFromEuler(new THREE.Euler(-1.4, 0.3, -0.5, "YXZ"));
    proxy.get("RightForeArm")!.quaternion.setFromEuler(new THREE.Euler(-1.9, 0, 0, "YXZ"));
    proxy.get("RightUpLeg")!.quaternion.setFromEuler(new THREE.Euler(-1.1, 0, 0.4, "YXZ"));
    proxy.get("Spine1")!.quaternion.setFromEuler(new THREE.Euler(0.5, 0.2, 0, "YXZ"));
    proxy.get("Hips")!.position.x += 0.3;
    space.rotation.y = 0.9; // camera orbiting must not matter
    space.updateMatrixWorld(true);
    retarget.update();

    const pairs: [string, string][] = [
      ["LeftArm", "LeftForeArm"],
      ["RightUpLeg", "RightLeg"],
      ["Spine1", "Neck"],
    ];
    for (const [a, b] of pairs) {
      const want = dir(proxy.get(a)!, proxy.get(b)!);
      const got = dir(bones.get(a)!, bones.get(b)!);
      expect(got.distanceTo(want)).toBeLessThan(1e-4);
    }
    // Forearm has no logical child: compare against its local -Y axis
    const wantFore = new THREE.Vector3(0, -1, 0).applyQuaternion(proxy.get("RightForeArm")!.getWorldQuaternion(new THREE.Quaternion()));
    expect(dir(bones.get("RightForeArm")!, bones.get("RightHand")!).distanceTo(wantFore)).toBeLessThan(1e-4);
    // Pelvis follows the logical rig's translation
    expect(worldPos(bones.get("Hips")!).distanceTo(worldPos(proxy.get("Hips")!))).toBeLessThan(1e-5);
  });

  it("fits the model scale so the glb's hips height matches the rig's", () => {
    const { proxy, model, glbBones } = setup();
    // Give the model some bounding geometry: a unit-ish box at the feet
    const feet = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    glbBones.get("LeftFoot")!.add(feet);
    const s = fitScaleToRig(model, glbBones.get("Hips")!, proxy.get("Hips")!.position.y);
    model.scale.setScalar(s);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    expect(worldPos(glbBones.get("Hips")!).y - box.min.y).toBeCloseTo(proxy.get("Hips")!.position.y, 3);
  });
});
