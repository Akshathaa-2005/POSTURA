import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import type { AvatarCommand } from "@/types";
import type { Landmark } from "@/types/mediapipe";
import { solveLandmarksToAvatar } from "@/utils/kinematicSolver";
import { buildExerciseReplaySequence, getExerciseAnchor } from "@/utils/exerciseReplays";
import type { ExerciseKeyframe } from "@/utils/exerciseReplays";
import {
  applyPoseRotations,
  buildRigSkeleton,
  centerAvatar,
  createGroundingState,
  eulerDegToQuaternion,
  FLOOR_Y,
  groundAvatar,
} from "@/utils/avatarRig";
import type { GroundAnchor } from "@/utils/avatarRig";
import { clampAnatomicalRotation } from "@/utils/kinematicSolver";

interface Props {
  command?: AvatarCommand | null;
  exerciseId?: string;
  defaultView?: "perspective" | "side" | "front";
  className?: string;
  autoPlay?: boolean;
  isSpeaking?: boolean;
  /** Live MediaPipe landmarks ref for 60 FPS real-time motion mimicry */
  liveLandmarksRef?: React.MutableRefObject<Landmark[] | null>;
  /** Video width / height of the landmark source, for undistorted limb directions */
  liveAspectRef?: React.MutableRefObject<number>;
  cameraOn?: boolean;
  mirrored?: boolean;
  /**
   * "fill" (default) stretches to its parent with the controls below the viewport.
   * "video" is a 16:9 stage like the camera feed, with the controls laid over its bottom edge, so the two sit side by side
   * at exactly the same size.
   */
  stage?: "fill" | "video";
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
  liveAspectRef,
  cameraOn = false,
  mirrored = true,
  stage = "fill",
}: Props) {
  const video = stage === "video";
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
  const liveAspectRefCurrent = useRef(liveAspectRef);
  liveAspectRefCurrent.current = liveAspectRef;
  // How the avatar stays planted on the floor (feet, hands, pelvis) for the current exercise
  const anchorRef = useRef<GroundAnchor>(getExerciseAnchor(exerciseId));
  const groundingRef = useRef(createGroundingState());
  /** Commanded head orientation; the idle micro-sway is layered on top of it. */
  const headBaseRef = useRef(new THREE.Object3D());

  useEffect(() => {
    anchorRef.current = getExerciseAnchor(exerciseId);
  }, [exerciseId]);

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
  const initialQuaternionsRef = useRef<Map<string, THREE.Quaternion>>(new Map());
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

  // Coach verbal cue overlay (shown during replay)
  const [coachCue, setCoachCue] = useState<string | null>(null);
  const [replayPhaseLabel, setReplayPhaseLabel] = useState<string | null>(null);
  // Pending replay keyframe timeouts for idempotent cancellation
  const replayTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

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

  /** Completely resets all bone orientations and positions to the immutable bind pose snapshot */
  const resetPose = useCallback(() => {
    replayTimeoutsRef.current.forEach(clearTimeout);
    replayTimeoutsRef.current = [];
    tweensRef.current = [];
    setCoachCue(null);
    setReplayPhaseLabel(null);
    bonesRef.current.forEach((bone, name) => {
      const initQuat = initialQuaternionsRef.current.get(name);
      if (initQuat) bone.quaternion.copy(initQuat);
      const initPos = initialPositionsRef.current.get(name);
      if (initPos) bone.position.copy(initPos);
    });
    headBaseRef.current.quaternion.identity();
    anchorRef.current = getExerciseAnchor(exerciseId);
    if (orbitGroupRef.current) {
      groundAvatar(bonesRef.current, orbitGroupRef.current, groundingRef.current, anchorRef.current);
      centerAvatar(bonesRef.current, orbitGroupRef.current, groundingRef.current);
    }

    jointMeshesRef.current.forEach((mesh) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.color.setHex(0xe53935);
      mat.emissive.setHex(0x991b1b);
    });
  }, [exerciseId]);

  /** Schedules a single keyframe phase onto the tween queue. */
  const scheduleKeyframe = useCallback((
    kf: ExerciseKeyframe,
    highlightJoints: string[],
    delayMs: number
  ) => {
    const id = setTimeout(() => {
      const now = performance.now();

      // ── Update joint highlights ──────────────────────────────────────────────
      const activeHighlights = kf.highlightJoints ?? highlightJoints;
      jointMeshesRef.current.forEach((mesh, name) => {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const isHighlighted = activeHighlights.some(
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

      // ── Update coach cue overlay ─────────────────────────────────────────────
      setCoachCue(kf.cue);
      setReplayPhaseLabel(kf.phaseLabel);

      // ── Per-bone tweens from the current pose → keyframe target ─────────────
      // The floor-contact pass places the hips, so only rotations are tweened.
      for (const [boneName, rotDeg] of Object.entries(kf.boneRotations)) {
        if (!rotDeg) continue; // guard for Partial<Record> undefined values
        const realBone = bonesRef.current.get(boneName);
        if (!realBone) continue;
        // Head tweens drive the commanded base orientation; the render loop adds the idle sway
        const bone = boneName === "Head" ? headBaseRef.current : realBone;

        tweensRef.current = tweensRef.current.filter((t) => t.boneName !== boneName);
        tweensRef.current.push({
          boneName,
          boneObject: bone,
          startQuat: bone.quaternion.clone(),
          targetQuat: eulerDegToQuaternion(clampAnatomicalRotation(boneName, rotDeg)),
          startTime: now,
          duration: kf.durationMs,
          easing: kf.easing,
        });
      }
    }, delayMs);

    replayTimeoutsRef.current.push(id);
  }, []);

  /**
   * Full Exercise Replay — Idempotent Multi-Stage Demonstration.
   *
   * Each click:
   *   1. Cancels any pending replay timeouts (prevents overlapping sequences).
   *   2. Clears active tweens and snaps the model into the demo's starting position on the floor.
   *   3. Schedules each exercise keyframe as a chained, delayed tween batch.
   *   4. Shows a coach cue overlay and joint highlights per stage.
   *
   * Repeated clicks always produce an identical result — no cumulative drift.
   */
  const applyCommand = useCallback((cmd: AvatarCommand | null) => {
    // ── 1. Cancel any running replay sequence ────────────────────────────────
    replayTimeoutsRef.current.forEach(clearTimeout);
    replayTimeoutsRef.current = [];
    tweensRef.current = [];

    // ── 2. Build the exercise demo (focused on the fault when there is one) ──
    const seq = buildExerciseReplaySequence(cmd, exerciseId);

    // ── 3. Snap into the starting position, centred and standing on the floor ─
    const orbitGroup = orbitGroupRef.current;
    const startPose = seq.keyframes[0]?.boneRotations ?? {};
    bonesRef.current.forEach((bone, name) => {
      const bindPos = initialPositionsRef.current.get(name);
      if (bindPos) bone.position.copy(bindPos);
    });
    applyPoseRotations(bonesRef.current, startPose);
    headBaseRef.current.quaternion.copy(bonesRef.current.get("Head")?.quaternion ?? new THREE.Quaternion());
    anchorRef.current = seq.anchor;
    if (orbitGroup) {
      groundAvatar(bonesRef.current, orbitGroup, groundingRef.current, seq.anchor);
      centerAvatar(bonesRef.current, orbitGroup, groundingRef.current);
      groundAvatar(bonesRef.current, orbitGroup, groundingRef.current, seq.anchor);
    }

    // Show the top-level verbal cue immediately
    setCoachCue(seq.verbalCue);
    setReplayPhaseLabel(seq.keyframes[0]?.phaseLabel ?? null);

    // ── 4. Apply initial joint highlights ───────────────────────────────────
    jointMeshesRef.current.forEach((mesh, name) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const isHighlighted = seq.highlightJoints.some(
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

    // ── 5. Schedule each keyframe as a chained delay ────────────────────────
    // Each keyframe fires after all previous durations have elapsed
    let cumulativeDelay = 0;
    for (const kf of seq.keyframes) {
      scheduleKeyframe(kf, seq.highlightJoints, cumulativeDelay);
      cumulativeDelay += kf.durationMs;
    }

    // ── 6. Clear cue overlay after the full sequence ends ───────────────────
    const clearId = setTimeout(() => {
      setCoachCue(null);
      setReplayPhaseLabel(null);
    }, cumulativeDelay + 1200);
    replayTimeoutsRef.current.push(clearId);
  }, [exerciseId, scheduleKeyframe]);



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
    floor.position.y = FLOOR_Y - 0.002;
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

    // Bone hierarchy (segment lengths) is shared with the replay library and ground-contact solver
    const bones = buildRigSkeleton();
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
    const hips = bones.get("Hips")!;
    orbitGroup.add(hips);
    const hipsJoint = makeJoint("Hips", 0.03);

    // Anatomical Pelvis & Gluteal Muscle Volume
    const pelvisGeo = new THREE.CylinderGeometry(0.145, 0.128, 0.16, 24);
    pelvisGeo.scale(1.12, 1.0, 0.88);
    const pelvisMesh = new THREE.Mesh(pelvisGeo, clayMat);
    pelvisMesh.position.set(0, -0.015, 0);
    pelvisMesh.castShadow = true;
    hips.add(pelvisMesh);

    // 2. Spine (Lumbar / Abdomen)
    const spine = bones.get("Spine")!;
    const spineJoint = makeJoint("Spine", 0.024);

    // Abdominal wall with tapered athletic waist
    const lumbarGeo = new THREE.CylinderGeometry(0.138, 0.144, 0.12, 24);
    lumbarGeo.scale(1.08, 1.0, 0.86);
    const lumbarMesh = new THREE.Mesh(lumbarGeo, clayMat);
    lumbarMesh.position.set(0, 0.06, 0);
    lumbarMesh.castShadow = true;
    spine.add(lumbarMesh);

    // 3. Spine1 (Chest / Thorax / Pectorals)
    const spine1 = bones.get("Spine1")!;
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
    const neck = bones.get("Neck")!;
    neckRef.current = neck;
    const neckJoint = makeJoint("Neck", 0.022);

    const neckGeo = new THREE.CylinderGeometry(0.046, 0.054, 0.085, 20);
    const neckMesh = new THREE.Mesh(neckGeo, clayMat);
    neckMesh.position.set(0, 0.04, 0);
    neckMesh.castShadow = true;
    neck.add(neckMesh);

    // Head (neutral upright posture with -1.8cm axial cervical retraction)
    const head = bones.get("Head")!;
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
    const leftUpLeg = bones.get("LeftUpLeg")!;
    const leftHipJoint = makeJoint("LeftUpLeg", 0.026);

    // Anatomical Quadriceps Thigh (broader at top, defined teardrop)
    const thighGeo = new THREE.CapsuleGeometry(0.064, 0.28, 16, 24);
    thighGeo.scale(1.05, 1.0, 1.15); // muscular anterior curve
    const leftThigh = new THREE.Mesh(thighGeo, clayMat);
    leftThigh.position.set(0, -0.18, 0);
    leftThigh.castShadow = true;
    leftUpLeg.add(leftThigh);

    const leftLeg = bones.get("LeftLeg")!;
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

    const leftFoot = bones.get("LeftFoot")!;
    const leftAnkleJoint = makeJoint("LeftFoot", 0.022);

    const footGeo = new THREE.BoxGeometry(0.076, 0.055, 0.17);
    const leftFootMesh = new THREE.Mesh(footGeo, clayMat);
    leftFootMesh.position.set(0, -0.02, 0.045);
    leftFootMesh.castShadow = true;
    leftFoot.add(leftFootMesh);

    // 6. Right Leg (Hip -> Quadriceps -> Knee -> Calf -> Foot)
    const rightUpLeg = bones.get("RightUpLeg")!;
    const rightHipJoint = makeJoint("RightUpLeg", 0.026);

    const rightThigh = new THREE.Mesh(thighGeo, clayMat);
    rightThigh.position.set(0, -0.18, 0);
    rightThigh.castShadow = true;
    rightUpLeg.add(rightThigh);

    const rightLeg = bones.get("RightLeg")!;
    const rightKneeJoint = makeJoint("RightLeg", 0.026);

    const rightPatella = new THREE.Mesh(patellaGeo, contourMat);
    rightPatella.position.set(0, 0, 0.04);
    rightLeg.add(rightPatella);

    const rightCalf = new THREE.Mesh(calfGeo, clayMat);
    rightCalf.position.set(0, -0.19, -0.005);
    rightCalf.castShadow = true;
    rightLeg.add(rightCalf);

    const rightFoot = bones.get("RightFoot")!;
    const rightAnkleJoint = makeJoint("RightFoot", 0.022);

    const rightFootMesh = new THREE.Mesh(footGeo, clayMat);
    rightFootMesh.position.set(0, -0.02, 0.045);
    rightFootMesh.castShadow = true;
    rightFoot.add(rightFootMesh);

    // 7. Left Arm (Shoulder -> Deltoid -> Bicep -> Forearm -> Hand)
    const leftArm = bones.get("LeftArm")!;
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

    const leftForeArm = bones.get("LeftForeArm")!;
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
    const rightArm = bones.get("RightArm")!;
    const rightShoulderJoint = makeJoint("RightArm", 0.026);

    const rightDeltoid = new THREE.Mesh(deltoidGeo, contourMat);
    rightDeltoid.position.set(0.01, -0.02, 0);
    rightArm.add(rightDeltoid);

    const rightBicep = new THREE.Mesh(bicepGeo, clayMat);
    rightBicep.position.set(0, -0.13, 0);
    rightBicep.castShadow = true;
    rightArm.add(rightBicep);

    const rightForeArm = bones.get("RightForeArm")!;
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
      initialQuaternionsRef.current.set(name, bone.quaternion.clone());
    });
    headBaseRef.current.quaternion.identity();
    groundAvatar(bones, orbitGroup, groundingRef.current, anchorRef.current);
    centerAvatar(bones, orbitGroup, groundingRef.current);

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
    const identityQuat = new THREE.Quaternion();
    const swayEuler = new THREE.Euler();
    const swayQuat = new THREE.Quaternion();

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
        const aspect = liveAspectRefCurrent.current?.current || 16 / 9;
        const solved = solveLandmarksToAvatar(lms, mirroredRef.current, { aspect });
        if (solved) {
          hasLivePose = true;
          // Smoothly slerp each solved bone to mimic user's physical pose in real time
          solved.boneQuaternions.forEach((targetQuat, boneName) => {
            const bone = boneName === "Head" ? headBaseRef.current : bonesRef.current.get(boneName);
            bone?.quaternion.slerp(targetQuat, 0.32);
          });
        }
      }

      if (isMimic && !hasLivePose) {
        // Camera is active but user is momentarily out of frame: gently relax to neutral upright pose
        bonesRef.current.forEach((bone, name) => {
          const initQuat = initialQuaternionsRef.current.get(name);
          if (initQuat) bone.quaternion.slerp(initQuat, 0.08);
        });
        headBaseRef.current.quaternion.slerp(identityQuat, 0.08);
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

      // 3. Head = commanded orientation (+ organic micro-sway when not driven by mocap)
      if (headRef.current) {
        headRef.current.quaternion.copy(headBaseRef.current.quaternion);
        if (!hasLivePose) {
          swayEuler.set(
            Math.sin(timeSec * 0.75 + 0.4) * 0.014,
            Math.sin(timeSec * 0.55) * 0.018 + Math.sin(timeSec * 1.1) * 0.009,
            Math.sin(timeSec * 0.4 + 1.0) * 0.007,
            "YXZ"
          );
          headRef.current.quaternion.multiply(swayQuat.setFromEuler(swayEuler));
        }
      }

      // 4. Floor contact: lowest body point rests on the floor, planted feet / hands don't slide
      groundAvatar(bonesRef.current, orbitGroup, groundingRef.current, anchorRef.current, isMimic ? 0.01 : 0);

      // 5. Update Red Kinematic Bone Lines (Figure 3) in World Space
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
    <div
      className={`relative flex flex-col w-full rounded-2xl bg-[#0a0c10] overflow-hidden ${
        video ? "" : "h-full border border-slate/20"
      } ${className}`}
    >
      {/* 3D Viewport */}
      <div
        ref={mountRef}
        className={`relative w-full cursor-grab active:cursor-grabbing ${video ? "aspect-video" : "flex-1 min-h-[380px]"}`}
      >
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

        {/* Coach verbal cue + phase label overlay — shown during replay demos */}
        {coachCue && (
          <div className={`absolute left-3 right-3 z-20 pointer-events-none ${video ? "bottom-16" : "bottom-3"}`}>
            {replayPhaseLabel && (
              <div className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-blue-600/80 px-2.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm border border-blue-400/30">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-200 animate-pulse" />
                {replayPhaseLabel}
              </div>
            )}
            <div className="rounded-xl bg-[#0a0c10]/85 border border-slate-700/50 px-3 py-2 text-[12px] text-slate-100 leading-snug backdrop-blur-md shadow-xl">
              {coachCue}
            </div>
          </div>
        )}
      </div>

      {/* Aesthetic SMPL Model Control Bar */}
      <div
        className={`flex flex-wrap items-center justify-between border-t border-slate/20 bg-[#10141b]/90 px-4 py-2.5 text-xs text-slate-300 backdrop-blur-md ${
          video ? "absolute inset-x-0 bottom-0 z-20" : ""
        }`}
      >
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
              applyCommand(command ?? null);
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

          <button
            onClick={() => {
              setControlMode("coach");
              applyCommand(command ?? null);
            }}
            className="rounded-full bg-red-600/20 text-red-400 hover:bg-red-600/30 px-2.5 py-0.5 text-[11px] font-medium transition"
            title={command ? "Replay full exercise repetition with corrected form demo" : "Demonstrate a full repetition with correct form"}
          >
            {command ? "Replay Fix" : "Play Demo"}
          </button>
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
