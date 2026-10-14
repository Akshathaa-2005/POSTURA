import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import type { AvatarCommand } from "@/types";
import type { Landmark } from "@/types/mediapipe";
import { clampAnatomicalRotation, solveLandmarksToAvatar } from "@/utils/kinematicSolver";

interface Props {
  command?: AvatarCommand | null;
  exerciseId?: string;
  defaultView?: "perspective" | "side" | "front";
  className?: string;
  autoPlay?: boolean;
  isSpeaking?: boolean;
  /** Live MediaPipe landmarks ref for 60 FPS real-time motion mimicry */
  liveLandmarksRef?: React.MutableRefObject<Landmark[] | null>;
  cameraOn?: boolean;
  mirrored?: boolean;
}

interface ActiveTween {
  boneName: string;
  boneObject: THREE.Object3D;
  startQuat: THREE.Quaternion;
  targetQuat: THREE.Quaternion;
  startTime: number;
  duration: number;
  easing: "easeInOutQuad" | "easeOutCubic" | "linear";
}

export type AvatarVisualizationMode = "clay" | "rig" | "bands" | "full";
export type AvatarControlMode = "mimic" | "coach";

export default function AvatarCoach3D({
  command,
  exerciseId,
  defaultView = "perspective",
  className = "w-full h-full min-h-[440px]",
  autoPlay = true,
  isSpeaking = false,
  liveLandmarksRef,
  cameraOn = false,
  mirrored = true,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [viewAngle, setViewAngle] = useState<"perspective" | "side" | "front">(defaultView);
  const [visMode, setVisMode] = useState<AvatarVisualizationMode>("rig"); // defaults to Figure 3 (Kinematic Rig)
  const [controlMode, setControlMode] = useState<AvatarControlMode>("mimic");

  // Keep latest props available to the requestAnimationFrame loop without scene rebuilding
  const controlModeRef = useRef(controlMode);
  controlModeRef.current = controlMode;
  const cameraOnRef = useRef(cameraOn);
  cameraOnRef.current = cameraOn;
  const mirroredRef = useRef(mirrored);
  mirroredRef.current = mirrored;
  const liveLandmarksRefCurrent = useRef(liveLandmarksRef);
  liveLandmarksRefCurrent.current = liveLandmarksRef;

  // Auto-switch to live mimicry whenever camera becomes active
  useEffect(() => {
    if (cameraOn) {
      setControlMode("mimic");
    }
  }, [cameraOn]);

  // Core Three.js references
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const orbitGroupRef = useRef<THREE.Group | null>(null);
  const bonesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const initialRotationsRef = useRef<Map<string, THREE.Euler>>(new Map());
  const initialPositionsRef = useRef<Map<string, THREE.Vector3>>(new Map());
  const jointMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const tweensRef = useRef<ActiveTween[]>([]);
  const reqIdRef = useRef<number | null>(null);

  // Groups for toggleable visualization overlays (Figures 3 & 4)
  const rigOverlayGroupRef = useRef<THREE.Group | null>(null);
  const bandsOverlayGroupRef = useRef<THREE.Group | null>(null);

  // Anatomical animation refs for subtle lifelike motion
  const chestMeshRef = useRef<THREE.Object3D | null>(null);
  const neckRef = useRef<THREE.Object3D | null>(null);
  const headRef = useRef<THREE.Object3D | null>(null);

  // Mouse orbit dragging
  const isDraggingRef = useRef(false);
  const prevMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const setCameraPreset = useCallback((preset: "perspective" | "side" | "front") => {
    setViewAngle(preset);
    const orbitGroup = orbitGroupRef.current;
    if (!orbitGroup) return;

    switch (preset) {
      case "side":
        orbitGroup.rotation.y = Math.PI / 2;
        break;
      case "front":
        orbitGroup.rotation.y = 0;
        break;
      case "perspective":
      default:
        orbitGroup.rotation.y = Math.PI / 6;
        break;
    }
  }, []);

  const resetPose = useCallback(() => {
    tweensRef.current = [];
    bonesRef.current.forEach((bone, name) => {
      const initRot = initialRotationsRef.current.get(name);
      if (initRot) bone.rotation.copy(initRot);
      const initPos = initialPositionsRef.current.get(name);
      if (initPos) bone.position.copy(initPos);
    });

    jointMeshesRef.current.forEach((mesh) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.color.setHex(0xe53935);
      mat.emissive.setHex(0x991b1b);
    });
  }, []);

  const applyCommand = useCallback((cmd: AvatarCommand) => {
    if (!cmd || !cmd.avatar_actions) return;

    // Highlight flagged joints with vivid amber/coral glow
    jointMeshesRef.current.forEach((mesh, name) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const isHighlighted = cmd.highlight_joints?.some(
        (j) => j.toLowerCase() === name.toLowerCase() || name.toLowerCase().includes(j.toLowerCase())
      );
      if (isHighlighted) {
        mat.color.setHex(0xffaa00);
        mat.emissive.setHex(0xff7700);
      } else {
        mat.color.setHex(0xe53935);
        mat.emissive.setHex(0x881111);
      }
    });

    tweensRef.current = [];
    const now = performance.now();

    for (const action of cmd.avatar_actions) {
      const bone = bonesRef.current.get(action.bone_name);
      if (!bone) continue;

      const startQuat = bone.quaternion.clone();
      const safeRot = clampAnatomicalRotation(action.bone_name, action.target_rotation);
      const radX = THREE.MathUtils.degToRad(safeRot.x);
      const radY = THREE.MathUtils.degToRad(safeRot.y);
      const radZ = THREE.MathUtils.degToRad(safeRot.z);
      const deltaEuler = new THREE.Euler(radX, radY, radZ, "XYZ");
      const deltaQuat = new THREE.Quaternion().setFromEuler(deltaEuler);

      let targetQuat = new THREE.Quaternion();
      if (action.rotation_mode === "relative_offset") {
        targetQuat.multiplyQuaternions(startQuat, deltaQuat);
      } else {
        targetQuat.copy(deltaQuat);
      }

      tweensRef.current.push({
        boneName: action.bone_name,
        boneObject: bone,
        startQuat,
        targetQuat,
        startTime: now,
        duration: action.duration_ms || 800,
        easing: action.easing || "easeInOutQuad",
      });
    }
  }, []);

  // Update overlay visibility when visMode changes
  useEffect(() => {
    if (rigOverlayGroupRef.current) {
      rigOverlayGroupRef.current.visible = visMode === "rig" || visMode === "full";
    }
    if (bandsOverlayGroupRef.current) {
      bandsOverlayGroupRef.current.visible = visMode === "bands" || visMode === "full";
    }
  }, [visMode]);

  // Construct the SMPL / Anatomical Clay Studio Scene
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const width = mount.clientWidth || 400;
    const height = mount.clientHeight || 450;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    // Dark studio background matching reference image
    scene.background = new THREE.Color(0x0a0c10);

    const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 50);
    camera.position.set(0, 1.0, 3.4);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    rendererRef.current = renderer;
    mount.appendChild(renderer.domElement);

    const orbitGroup = new THREE.Group();
    orbitGroupRef.current = orbitGroup;
    scene.add(orbitGroup);

    // Overlay groups for Kinematic Skeleton (Fig 3) and Measurement Bands (Fig 4)
    const rigOverlayGroup = new THREE.Group();
    rigOverlayGroupRef.current = rigOverlayGroup;
    orbitGroup.add(rigOverlayGroup);

    const bandsOverlayGroup = new THREE.Group();
    bandsOverlayGroupRef.current = bandsOverlayGroup;
    orbitGroup.add(bandsOverlayGroup);

    // Studio Lighting setup to sculpt anatomical muscle contours
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambientLight);

    // Key light (angled high front-right)
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(2.4, 4.0, 3.2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.bias = -0.0004;
    scene.add(keyLight);

    // Fill light (softer cool light from left)
    const fillLight = new THREE.DirectionalLight(0xb0c4de, 0.6);
    fillLight.position.set(-2.8, 2.0, 2.2);
    scene.add(fillLight);

    // Rim back-light (creates crisp silhouette seen in anatomical reference scans)
    const rimLight = new THREE.DirectionalLight(0xffffff, 1.25);
    rimLight.position.set(0, 2.8, -3.2);
    scene.add(rimLight);

    // Dark floor pedestal
    const floorGeo = new THREE.CircleGeometry(1.4, 64);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x12151b,
      roughness: 0.95,
      metalness: 0.1,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    floor.receiveShadow = true;
    orbitGroup.add(floor);

    // ========================================================
    // Anatomical Clay Shader (Neutral Gray Matte Clay)
    // ========================================================
    const clayMat = new THREE.MeshStandardMaterial({
      color: 0x8e959e, // Matte clay tone matching SMPL reference
      roughness: 0.44,
      metalness: 0.08,
    });

    // Darker tone for muscular crevices and contours
    const contourMat = new THREE.MeshStandardMaterial({
      color: 0x7c838d,
      roughness: 0.48,
      metalness: 0.06,
    });

    // Kinematic Rig materials (Figure 3)
    const redJointMat = new THREE.MeshStandardMaterial({
      color: 0xe53935, // bright red dot
      emissive: 0x881111,
      roughness: 0.2,
      metalness: 0.1,
    });

    const redLineMat = new THREE.LineBasicMaterial({
      color: 0xee2222,
      linewidth: 2,
    });

    // Measurement Bands material (Figure 4)
    const bandMat = new THREE.LineBasicMaterial({
      color: 0xd32f2f,
      linewidth: 2,
    });

    const bones = new Map<string, THREE.Object3D>();
    const jointMeshes = new Map<string, THREE.Mesh>();

    const makeJoint = (name: string, radius = 0.026) => {
      const geo = new THREE.SphereGeometry(radius, 16, 16);
      const mesh = new THREE.Mesh(geo, redJointMat.clone());
      mesh.renderOrder = 2;
      jointMeshes.set(name, mesh);
      rigOverlayGroup.add(mesh);
      return mesh;
    };

    // Helper to draw horizontal measurement band rings
    const makeBandRing = (radiusX: number, radiusZ: number, y: number, parent: THREE.Object3D) => {
      const curve = new THREE.EllipseCurve(0, 0, radiusX, radiusZ, 0, 2 * Math.PI, false, 0);
      const points = curve.getPoints(48);
      const geo = new THREE.BufferGeometry().setFromPoints(
        points.map((p) => new THREE.Vector3(p.x, y, p.y))
      );
      const line = new THREE.LineLoop(geo, bandMat);
      line.renderOrder = 3;
      parent.add(line);
      return line;
    };

    // Helper for kinematic bone connection lines
    const linkKinematicBones = (objA: THREE.Object3D, objB: THREE.Object3D) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        new THREE.Vector3(),
      ]);
      const line = new THREE.Line(geo, redLineMat);
      line.renderOrder = 2;
      rigOverlayGroup.add(line);
      return { line, objA, objB };
    };

    const kinematicLinks: { line: THREE.Line; objA: THREE.Object3D; objB: THREE.Object3D }[] = [];

    // ========================================================
    // SMPL-Style Continuous Muscular Anatomy Construction
    // ========================================================

    // 1. Pelvis / Hips (Root)
    const hips = new THREE.Group();
    hips.position.set(0, 0.94, 0);
    orbitGroup.add(hips);
    bones.set("Hips", hips);
    const hipsJoint = makeJoint("Hips", 0.03);

    // Anatomical Pelvis & Gluteal Muscle Volume
    const pelvisGeo = new THREE.CylinderGeometry(0.145, 0.128, 0.16, 24);
    pelvisGeo.scale(1.12, 1.0, 0.88);
    const pelvisMesh = new THREE.Mesh(pelvisGeo, clayMat);
    pelvisMesh.position.set(0, -0.015, 0);
    pelvisMesh.castShadow = true;
    hips.add(pelvisMesh);

    // 2. Spine (Lumbar / Abdomen)
    const spine = new THREE.Group();
    spine.position.set(0, 0.075, 0);
    hips.add(spine);
    bones.set("Spine", spine);
    const spineJoint = makeJoint("Spine", 0.024);

    // Abdominal wall with tapered athletic waist
    const lumbarGeo = new THREE.CylinderGeometry(0.138, 0.144, 0.12, 24);
    lumbarGeo.scale(1.08, 1.0, 0.86);
    const lumbarMesh = new THREE.Mesh(lumbarGeo, clayMat);
    lumbarMesh.position.set(0, 0.06, 0);
    lumbarMesh.castShadow = true;
    spine.add(lumbarMesh);

    // 3. Spine1 (Chest / Thorax / Pectorals)
    const spine1 = new THREE.Group();
    spine1.position.set(0, 0.12, 0);
    spine.add(spine1);
    bones.set("Spine1", spine1);
    chestMeshRef.current = spine1;
    const chestJoint = makeJoint("Spine1", 0.026);

    // Sculpted Muscular Chest & Latissimus Dorsi
    const thoraxGeo = new THREE.CylinderGeometry(0.165, 0.14, 0.19, 28);
    thoraxGeo.scale(1.18, 1.0, 0.82); // broad chest, muscular athletic V-taper
    const thoraxMesh = new THREE.Mesh(thoraxGeo, clayMat);
    thoraxMesh.position.set(0, 0.095, 0.005);
    thoraxMesh.castShadow = true;
    spine1.add(thoraxMesh);

    // Defined Pectoral Major Plates (Left and Right)
    const leftPecGeo = new THREE.BoxGeometry(0.11, 0.08, 0.04);
    leftPecGeo.scale(1.0, 1.0, 0.8);
    const leftPec = new THREE.Mesh(leftPecGeo, contourMat);
    leftPec.position.set(-0.065, 0.115, 0.075);
    leftPec.rotation.set(-0.15, -0.15, -0.05);
    leftPec.castShadow = true;
    spine1.add(leftPec);

    const rightPec = new THREE.Mesh(leftPecGeo, contourMat);
    rightPec.position.set(0.065, 0.115, 0.075);
    rightPec.rotation.set(-0.15, 0.15, 0.05);
    rightPec.castShadow = true;
    spine1.add(rightPec);

    // 4. Neck & Anatomical Head
    const neck = new THREE.Group();
    neck.position.set(0, 0.195, 0.005);
    spine1.add(neck);
    bones.set("Neck", neck);
    neckRef.current = neck;
    const neckJoint = makeJoint("Neck", 0.022);

    const neckGeo = new THREE.CylinderGeometry(0.046, 0.054, 0.085, 20);
    const neckMesh = new THREE.Mesh(neckGeo, clayMat);
    neckMesh.position.set(0, 0.04, 0);
    neckMesh.castShadow = true;
    neck.add(neckMesh);

    // Head
    const head = new THREE.Group();
    head.position.set(0, 0.085, 0);
    neck.add(head);
    bones.set("Head", head);
    headRef.current = head;
    const headJoint = makeJoint("Head", 0.024);

    // Anatomical Cranium & Sculpted Facial Structure
    const craniumGeo = new THREE.SphereGeometry(0.088, 28, 28);
    craniumGeo.scale(0.92, 1.16, 1.04);
    const cranium = new THREE.Mesh(craniumGeo, clayMat);
    cranium.position.set(0, 0.078, 0);
    cranium.castShadow = true;
    head.add(cranium);

    // Sculpted Jawline & Chin
    const jawGeo = new THREE.BoxGeometry(0.054, 0.042, 0.065);
    const jaw = new THREE.Mesh(jawGeo, contourMat);
    jaw.position.set(0, 0.025, 0.045);
    jaw.rotation.x = -0.2;
    head.add(jaw);

    // Brow & Nose Bridge Definition
    const browGeo = new THREE.BoxGeometry(0.07, 0.016, 0.03);
    const brow = new THREE.Mesh(browGeo, contourMat);
    brow.position.set(0, 0.085, 0.076);
    head.add(brow);

    const noseGeo = new THREE.ConeGeometry(0.016, 0.038, 4);
    noseGeo.rotateX(Math.PI / 4.2);
    const nose = new THREE.Mesh(noseGeo, clayMat);
    nose.position.set(0, 0.064, 0.085);
    head.add(nose);

    // 5. Left Leg (Hip -> Quadriceps -> Knee -> Calf -> Foot)
    const leftUpLeg = new THREE.Group();
    leftUpLeg.position.set(-0.1, -0.05, 0);
    hips.add(leftUpLeg);
    bones.set("LeftUpLeg", leftUpLeg);
    const leftHipJoint = makeJoint("LeftUpLeg", 0.026);

    // Anatomical Quadriceps Thigh (broader at top, defined teardrop)
    const thighGeo = new THREE.CapsuleGeometry(0.064, 0.28, 16, 24);
    thighGeo.scale(1.05, 1.0, 1.15); // muscular anterior curve
    const leftThigh = new THREE.Mesh(thighGeo, clayMat);
    leftThigh.position.set(0, -0.18, 0);
    leftThigh.castShadow = true;
    leftUpLeg.add(leftThigh);

    const leftLeg = new THREE.Group();
    leftLeg.position.set(0, -0.38, 0);
    leftUpLeg.add(leftLeg);
    bones.set("LeftLeg", leftLeg);
    const leftKneeJoint = makeJoint("LeftLeg", 0.026);

    // Defined Patella (Kneecap)
    const patellaGeo = new THREE.SphereGeometry(0.032, 16, 16);
    patellaGeo.scale(1.0, 1.1, 0.7);
    const leftPatella = new THREE.Mesh(patellaGeo, contourMat);
    leftPatella.position.set(0, 0, 0.04);
    leftLeg.add(leftPatella);

    // Calf (Gastrocnemius contour tapering to Achilles)
    const calfGeo = new THREE.CapsuleGeometry(0.048, 0.3, 16, 24);
    calfGeo.scale(1.0, 1.0, 1.15); // muscular posterior curve
    const leftCalf = new THREE.Mesh(calfGeo, clayMat);
    leftCalf.position.set(0, -0.19, -0.005);
    leftCalf.castShadow = true;
    leftLeg.add(leftCalf);

    const leftFoot = new THREE.Group();
    leftFoot.position.set(0, -0.38, 0);
    leftLeg.add(leftFoot);
    bones.set("LeftFoot", leftFoot);
    const leftAnkleJoint = makeJoint("LeftFoot", 0.022);

    const footGeo = new THREE.BoxGeometry(0.076, 0.055, 0.17);
    const leftFootMesh = new THREE.Mesh(footGeo, clayMat);
    leftFootMesh.position.set(0, -0.02, 0.045);
    leftFootMesh.castShadow = true;
    leftFoot.add(leftFootMesh);

    // 6. Right Leg (Hip -> Quadriceps -> Knee -> Calf -> Foot)
    const rightUpLeg = new THREE.Group();
    rightUpLeg.position.set(0.1, -0.05, 0);
    hips.add(rightUpLeg);
    bones.set("RightUpLeg", rightUpLeg);
    const rightHipJoint = makeJoint("RightUpLeg", 0.026);

    const rightThigh = new THREE.Mesh(thighGeo, clayMat);
    rightThigh.position.set(0, -0.18, 0);
    rightThigh.castShadow = true;
    rightUpLeg.add(rightThigh);

    const rightLeg = new THREE.Group();
    rightLeg.position.set(0, -0.38, 0);
    rightUpLeg.add(rightLeg);
    bones.set("RightLeg", rightLeg);
    const rightKneeJoint = makeJoint("RightLeg", 0.026);

    const rightPatella = new THREE.Mesh(patellaGeo, contourMat);
    rightPatella.position.set(0, 0, 0.04);
    rightLeg.add(rightPatella);

    const rightCalf = new THREE.Mesh(calfGeo, clayMat);
    rightCalf.position.set(0, -0.19, -0.005);
    rightCalf.castShadow = true;
    rightLeg.add(rightCalf);

    const rightFoot = new THREE.Group();
    rightFoot.position.set(0, -0.38, 0);
    rightLeg.add(rightFoot);
    bones.set("RightFoot", rightFoot);
    const rightAnkleJoint = makeJoint("RightFoot", 0.022);

    const rightFootMesh = new THREE.Mesh(footGeo, clayMat);
    rightFootMesh.position.set(0, -0.02, 0.045);
    rightFootMesh.castShadow = true;
    rightFoot.add(rightFootMesh);

    // 7. Left Arm (Shoulder -> Deltoid -> Bicep -> Forearm -> Hand)
    const leftArm = new THREE.Group();
    leftArm.position.set(-0.18, 0.17, 0);
    spine1.add(leftArm);
    bones.set("LeftArm", leftArm);
    const leftShoulderJoint = makeJoint("LeftArm", 0.026);

    // Sculpted Deltoid Cap
    const deltoidGeo = new THREE.SphereGeometry(0.052, 18, 18);
    deltoidGeo.scale(0.9, 1.25, 1.0);
    const leftDeltoid = new THREE.Mesh(deltoidGeo, contourMat);
    leftDeltoid.position.set(-0.01, -0.02, 0);
    leftArm.add(leftDeltoid);

    // Bicep/Tricep Upper Arm
    const bicepGeo = new THREE.CapsuleGeometry(0.042, 0.18, 16, 20);
    const leftBicep = new THREE.Mesh(bicepGeo, clayMat);
    leftBicep.position.set(0, -0.13, 0);
    leftBicep.castShadow = true;
    leftArm.add(leftBicep);

    const leftForeArm = new THREE.Group();
    leftForeArm.position.set(0, -0.26, 0);
    leftArm.add(leftForeArm);
    bones.set("LeftForeArm", leftForeArm);
    const leftElbowJoint = makeJoint("LeftForeArm", 0.024);

    // Forearm
    const forearmGeo = new THREE.CapsuleGeometry(0.036, 0.18, 16, 20);
    const leftForearmMesh = new THREE.Mesh(forearmGeo, clayMat);
    leftForearmMesh.position.set(0, -0.12, 0);
    leftForearmMesh.castShadow = true;
    leftForeArm.add(leftForearmMesh);

    const leftWristJoint = makeJoint("LeftWrist", 0.02);
    leftWristJoint.position.set(0, -0.22, 0);
    leftForeArm.add(leftWristJoint);

    const handGeo = new THREE.BoxGeometry(0.04, 0.07, 0.028);
    const leftHand = new THREE.Mesh(handGeo, clayMat);
    leftHand.position.set(0, -0.25, 0);
    leftForeArm.add(leftHand);

    // 8. Right Arm (Shoulder -> Deltoid -> Bicep -> Forearm -> Hand)
    const rightArm = new THREE.Group();
    rightArm.position.set(0.18, 0.17, 0);
    spine1.add(rightArm);
    bones.set("RightArm", rightArm);
    const rightShoulderJoint = makeJoint("RightArm", 0.026);

    const rightDeltoid = new THREE.Mesh(deltoidGeo, contourMat);
    rightDeltoid.position.set(0.01, -0.02, 0);
    rightArm.add(rightDeltoid);

    const rightBicep = new THREE.Mesh(bicepGeo, clayMat);
    rightBicep.position.set(0, -0.13, 0);
    rightBicep.castShadow = true;
    rightArm.add(rightBicep);

    const rightForeArm = new THREE.Group();
    rightForeArm.position.set(0, -0.26, 0);
    rightArm.add(rightForeArm);
    bones.set("RightForeArm", rightForeArm);
    const rightElbowJoint = makeJoint("RightForeArm", 0.024);

    const rightForearmMesh = new THREE.Mesh(forearmGeo, clayMat);
    rightForearmMesh.position.set(0, -0.12, 0);
    rightForearmMesh.castShadow = true;
    rightForeArm.add(rightForearmMesh);

    const rightWristJoint = makeJoint("RightWrist", 0.02);
    rightWristJoint.position.set(0, -0.22, 0);
    rightForeArm.add(rightWristJoint);

    const rightHand = new THREE.Mesh(handGeo, clayMat);
    rightHand.position.set(0, -0.25, 0);
    rightForeArm.add(rightHand);

    // ========================================================
    // Kinematic Bone Lines Setup (Figure 3)
    // ========================================================
    kinematicLinks.push(linkKinematicBones(hipsJoint, spineJoint));
    kinematicLinks.push(linkKinematicBones(spineJoint, chestJoint));
    kinematicLinks.push(linkKinematicBones(chestJoint, neckJoint));
    kinematicLinks.push(linkKinematicBones(neckJoint, headJoint));

    // Upper Body
    kinematicLinks.push(linkKinematicBones(chestJoint, leftShoulderJoint));
    kinematicLinks.push(linkKinematicBones(leftShoulderJoint, leftElbowJoint));
    kinematicLinks.push(linkKinematicBones(leftElbowJoint, leftWristJoint));

    kinematicLinks.push(linkKinematicBones(chestJoint, rightShoulderJoint));
    kinematicLinks.push(linkKinematicBones(rightShoulderJoint, rightElbowJoint));
    kinematicLinks.push(linkKinematicBones(rightElbowJoint, rightWristJoint));

    // Lower Body
    kinematicLinks.push(linkKinematicBones(hipsJoint, leftHipJoint));
    kinematicLinks.push(linkKinematicBones(leftHipJoint, leftKneeJoint));
    kinematicLinks.push(linkKinematicBones(leftKneeJoint, leftAnkleJoint));

    kinematicLinks.push(linkKinematicBones(hipsJoint, rightHipJoint));
    kinematicLinks.push(linkKinematicBones(rightHipJoint, rightKneeJoint));
    kinematicLinks.push(linkKinematicBones(rightKneeJoint, rightAnkleJoint));

    // ========================================================
    // Biomechanical Measurement Rings Setup (Figure 4)
    // ========================================================
    // Headband
    makeBandRing(0.088, 0.096, 0.08, head);
    // Neck band
    makeBandRing(0.052, 0.052, 0.04, neck);
    // Upper Chest band
    makeBandRing(0.185, 0.138, 0.14, spine1);
    // Lower Chest / Bust band
    makeBandRing(0.172, 0.126, 0.06, spine1);
    // Waist band
    makeBandRing(0.148, 0.116, 0.05, spine);
    // Hip circumference band
    makeBandRing(0.162, 0.138, -0.02, hips);
    // Thigh cross-section bands
    makeBandRing(0.068, 0.068, -0.16, leftUpLeg);
    makeBandRing(0.068, 0.068, -0.16, rightUpLeg);
    // Calf cross-section bands
    makeBandRing(0.052, 0.052, -0.16, leftLeg);
    makeBandRing(0.052, 0.052, -0.16, rightLeg);
    // Wrist bands
    makeBandRing(0.038, 0.038, -0.21, leftForeArm);
    makeBandRing(0.038, 0.038, -0.21, rightForeArm);

    // Initial overlay mode visibility
    rigOverlayGroup.visible = visMode === "rig" || visMode === "full";
    bandsOverlayGroup.visible = visMode === "bands" || visMode === "full";

    bonesRef.current = bones;
    jointMeshesRef.current = jointMeshes;
    bones.forEach((bone, name) => {
      initialRotationsRef.current.set(name, bone.rotation.clone());
      initialPositionsRef.current.set(name, bone.position.clone());
    });

    setCameraPreset(defaultView);

    // Mouse drag handlers
    const onMouseDown = (e: MouseEvent) => {
      isDraggingRef.current = true;
      prevMouseRef.current = { x: e.clientX, y: e.clientY };
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !orbitGroupRef.current) return;
      const dx = e.clientX - prevMouseRef.current.x;
      orbitGroupRef.current.rotation.y += dx * 0.01;
      prevMouseRef.current = { x: e.clientX, y: e.clientY };
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
    };

    const domElement = renderer.domElement;
    domElement.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    // Render loop with Kinematic Link Updates
    const posA = new THREE.Vector3();
    const posB = new THREE.Vector3();

    const animate = () => {
      reqIdRef.current = requestAnimationFrame(animate);

      const now = performance.now();
      const timeSec = now * 0.001;
      const tweens = tweensRef.current;

      // 1. Live Motion Mimicry vs Guided Coach Tweens
      const isMimic = controlModeRef.current === "mimic" && cameraOnRef.current;
      const lms = liveLandmarksRefCurrent.current?.current;
      let hasLivePose = false;

      if (isMimic && lms) {
        const solved = solveLandmarksToAvatar(lms, mirroredRef.current);
        if (solved) {
          hasLivePose = true;
          // Smoothly slerp each solved bone to mimic user's physical pose in real time
          solved.boneQuaternions.forEach((targetQuat, boneName) => {
            const bone = bonesRef.current.get(boneName);
            if (bone) {
              bone.quaternion.slerp(targetQuat, 0.32);
            }
          });

          // Adjust hips height dynamically for squats, lunges, and jumping jacks
          if (solved.hipsPosition) {
            const hipsBone = bonesRef.current.get("Hips");
            if (hipsBone) {
              hipsBone.position.lerp(solved.hipsPosition, 0.25);
            }
          }
        }
      }

      if (isMimic && !hasLivePose) {
        // Camera is active but user is momentarily out of frame: gently relax to neutral upright pose
        bonesRef.current.forEach((bone, name) => {
          const initRot = initialRotationsRef.current.get(name);
          if (initRot) {
            const targetQuat = new THREE.Quaternion().setFromEuler(initRot);
            bone.quaternion.slerp(targetQuat, 0.08);
          }
          const initPos = initialPositionsRef.current.get(name);
          if (initPos) {
            bone.position.lerp(initPos, 0.08);
          }
        });
      }

      if (!isMimic) {
        // Guided coach tweens mode
        for (let i = tweens.length - 1; i >= 0; i--) {
          const tween = tweens[i];
          const elapsed = now - tween.startTime;
          const progress = Math.min(elapsed / tween.duration, 1.0);

          let ease = progress;
          if (tween.easing === "easeInOutQuad") {
            ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
          } else if (tween.easing === "easeOutCubic") {
            ease = 1 - Math.pow(1 - progress, 3);
          }

          tween.boneObject.quaternion.slerpQuaternions(tween.startQuat, tween.targetQuat, ease);

          if (progress >= 1.0) {
            tweens.splice(i, 1);
          }
        }
      }

      // 2. Subtle Natural Breathing (~16 breaths/min)
      const breath = Math.sin(timeSec * 1.6);
      if (chestMeshRef.current) {
        chestMeshRef.current.scale.set(1 + 0.012 * breath, 1 + 0.008 * breath, 1 + 0.016 * breath);
      }

      // 3. Subtle Organic Head Micro-Sway (only when head is not actively driven by mocap)
      const isNeckAnimating = hasLivePose || tweens.some((t) => t.boneName === "Neck" || t.boneName === "Head");
      if (!isNeckAnimating && headRef.current) {
        const headSwayYaw = Math.sin(timeSec * 0.55) * 0.018 + Math.sin(timeSec * 1.1) * 0.009;
        const headSwayPitch = Math.sin(timeSec * 0.75 + 0.4) * 0.014;
        const headSwayRoll = Math.sin(timeSec * 0.4 + 1.0) * 0.007;
        headRef.current.rotation.set(headSwayPitch, headSwayYaw, headSwayRoll);
      }

      // 4. Update Red Kinematic Bone Lines (Figure 3) in World Space
      if (rigOverlayGroup.visible) {
        for (const link of kinematicLinks) {
          link.objA.getWorldPosition(posA);
          link.objB.getWorldPosition(posB);
          orbitGroup.worldToLocal(posA);
          orbitGroup.worldToLocal(posB);

          const positions = link.line.geometry.attributes.position.array as Float32Array;
          positions[0] = posA.x;
          positions[1] = posA.y;
          positions[2] = posA.z;
          positions[3] = posB.x;
          positions[4] = posB.y;
          positions[5] = posB.z;
          link.line.geometry.attributes.position.needsUpdate = true;
        }

        // Align joint sphere nodes to world positions
        const updateJointPos = (joint: THREE.Mesh, parentBone: THREE.Object3D) => {
          parentBone.getWorldPosition(posA);
          orbitGroup.worldToLocal(posA);
          joint.position.copy(posA);
        };

        updateJointPos(hipsJoint, hips);
        updateJointPos(spineJoint, spine);
        updateJointPos(chestJoint, spine1);
        updateJointPos(neckJoint, neck);
        updateJointPos(headJoint, head);
        updateJointPos(leftShoulderJoint, leftArm);
        updateJointPos(rightShoulderJoint, rightArm);
        updateJointPos(leftElbowJoint, leftForeArm);
        updateJointPos(rightElbowJoint, rightForeArm);
        updateJointPos(leftHipJoint, leftUpLeg);
        updateJointPos(rightHipJoint, rightUpLeg);
        updateJointPos(leftKneeJoint, leftLeg);
        updateJointPos(rightKneeJoint, rightLeg);
        updateJointPos(leftAnkleJoint, leftFoot);
        updateJointPos(rightAnkleJoint, rightFoot);
      }

      renderer.render(scene, camera);
    };

    animate();

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        }
      }
    });
    resizeObserver.observe(mount);

    return () => {
      resizeObserver.disconnect();
      if (reqIdRef.current) cancelAnimationFrame(reqIdRef.current);
      domElement.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      renderer.dispose();
      if (mount.contains(domElement)) {
        mount.removeChild(domElement);
      }
    };
  }, [defaultView, setCameraPreset]);

  useEffect(() => {
    if (!command) {
      // Clear highlight if no active command
      jointMeshesRef.current.forEach((mesh) => {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.color.setHex(0xe53935);
        mat.emissive.setHex(0x881111);
      });
      return;
    }

    // Always highlight flagged joints on the live avatar
    jointMeshesRef.current.forEach((mesh, name) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const isHighlighted = command.highlight_joints?.some(
        (j) => j.toLowerCase() === name.toLowerCase() || name.toLowerCase().includes(j.toLowerCase())
      );
      if (isHighlighted) {
        mat.color.setHex(0xffaa00);
        mat.emissive.setHex(0xff7700);
      } else {
        mat.color.setHex(0xe53935);
        mat.emissive.setHex(0x881111);
      }
    });

    if (autoPlay && controlMode === "coach") {
      applyCommand(command);
    }
  }, [command, autoPlay, controlMode, applyCommand]);

  return (
    <div className={`relative flex flex-col h-full w-full rounded-2xl bg-[#0a0c10] border border-slate/20 overflow-hidden ${className}`}>
      {/* 3D Viewport */}
      <div ref={mountRef} className="relative flex-1 w-full min-h-[380px] cursor-grab active:cursor-grabbing">
        {/* Status indicator badge */}
        <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-full bg-[#10141b]/85 px-3 py-1 text-[11px] border border-slate-700/50 backdrop-blur-md">
          {controlMode === "mimic" ? (
            cameraOn ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                <span className="text-emerald-300 font-medium">Live Motion Mirror · 60 FPS</span>
              </>
            ) : (
              <>
                <span className="h-2 w-2 rounded-full bg-amber-400/80" />
                <span className="text-stone-300">Awaiting Camera Feed</span>
              </>
            )
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-blue-400" />
              <span className="text-blue-200 font-medium">Coach Guidance Demo</span>
            </>
          )}
        </div>
      </div>

      {/* Aesthetic SMPL Model Control Bar */}
      <div className="flex flex-wrap items-center justify-between border-t border-slate/20 bg-[#10141b]/90 px-4 py-2.5 text-xs text-slate-300 backdrop-blur-md">
        {/* Tracking Mode Switcher (Mimic Live vs Coach Demo) */}
        <div className="flex items-center gap-1.5 border-r border-slate-700/60 pr-2">
          <button
            onClick={() => setControlMode("mimic")}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition flex items-center gap-1.5 ${
              controlMode === "mimic"
                ? "bg-emerald-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Real-time 60 FPS Motion-Capture Digital Twin"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${cameraOn ? "bg-emerald-200 animate-pulse" : "bg-slate-400"}`} />
            Mimic Live
          </button>
          <button
            onClick={() => {
              setControlMode("coach");
              if (command) applyCommand(command);
            }}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition flex items-center gap-1.5 ${
              controlMode === "coach"
                ? "bg-blue-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Demonstrate Corrected Form"
          >
            Coach Demo
          </button>
        </div>

        {/* Visualization Modes (matching the 4 figures in reference image) */}
        <div className="flex items-center gap-1">
          <span className="eyebrow !text-[10px] mr-1.5 text-slate-400">Mode:</span>
          <button
            onClick={() => setVisMode("clay")}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
              visMode === "clay" ? "bg-slate-200 text-slate-900 shadow-sm" : "text-slate-400 hover:text-slate-200"
            }`}
            title="Clean Anatomical Clay Mesh (Fig 1 & 2)"
          >
            Body
          </button>
          <button
            onClick={() => setVisMode("rig")}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
              visMode === "rig" ? "bg-red-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"
            }`}
            title="Kinematic Skeleton Rig (Fig 3)"
          >
            Kinematic Rig
          </button>
          <button
            onClick={() => setVisMode("bands")}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
              visMode === "bands" ? "bg-red-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"
            }`}
            title="Biomechanical Measurement Bands (Fig 4)"
          >
            Bands
          </button>
          <button
            onClick={() => setVisMode("full")}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
              visMode === "full" ? "bg-red-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"
            }`}
            title="Complete Rig & Measurement Overlay"
          >
            Full
          </button>
        </div>

        {/* Camera Angles & Action */}
        <div className="flex items-center gap-2 mt-1 sm:mt-0">
          <div className="flex items-center gap-1 border-r border-slate-700/60 pr-2">
            <button
              onClick={() => setCameraPreset("perspective")}
              className={`rounded-full px-2 py-0.5 text-[10px] ${viewAngle === "perspective" ? "text-white font-medium" : "text-slate-400"}`}
            >
              3/4
            </button>
            <button
              onClick={() => setCameraPreset("side")}
              className={`rounded-full px-2 py-0.5 text-[10px] ${viewAngle === "side" ? "text-white font-medium" : "text-slate-400"}`}
            >
              Side
            </button>
            <button
              onClick={() => setCameraPreset("front")}
              className={`rounded-full px-2 py-0.5 text-[10px] ${viewAngle === "front" ? "text-white font-medium" : "text-slate-400"}`}
            >
              Front
            </button>
          </div>

          {command && (
            <button
              onClick={() => {
                setControlMode("coach");
                applyCommand(command);
              }}
              className="rounded-full bg-red-600/20 text-red-400 hover:bg-red-600/30 px-2.5 py-0.5 text-[11px] font-medium transition"
            >
              Replay Fix
            </button>
          )}
          <button
            onClick={resetPose}
            className="rounded-full bg-slate-800 text-slate-300 hover:text-white px-2 py-0.5 text-[10px] transition"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
