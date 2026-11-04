import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
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
import { followFactor, MIMIC_TAU_MS, RELAX_TAU_MS } from "@/utils/avatarRig";
import type { GroundAnchor } from "@/utils/avatarRig";
import { clampAnatomicalRotation } from "@/utils/kinematicSolver";
import { createGlbRetargeter, findGlbBones, fitScaleToRig, missingRigBones } from "@/utils/glbRetarget";
import type { GlbRetargeter } from "@/utils/glbRetarget";

/** Blender-exported character (see docs/blender-export.md). Served from frontend/public/models. */
// avatar_fixed.glb = avatar.glb with straight hands and smoothed weights (backend/scripts/blender_fix_avatar_rig.py)
const AVATAR_MODEL_URL = "/models/avatar_fixed.glb";

type ModelStatus = "loading" | "ready" | "error";

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

/** Default outward tilt (deg) of the upper arms so the glb's sleeves don't clip into the torso. */
const REST_ARM_ABDUCT_DEG = 12;

/** "clay" = body only; "rig" adds the kinematic joint dots and bone lines. */
export type AvatarVisualizationMode = "clay" | "rig";

/** Control-bar pill: same active / idle treatment as the site's Toggle (slate fill vs. stone text). */
const segment = (active: boolean) =>
  `rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest/30 ${
    active ? "border-slate bg-slate text-linen" : "border-transparent text-stone hover:text-ink"
  }`;

/** Floating status chip drawn over the viewport. */
const CHIP = "inline-flex items-center gap-2 rounded-full border border-slate/[0.07] bg-linen/90 px-3 py-1 text-[11px] text-ink shadow-soft backdrop-blur-sm";
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
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [viewAngle, setViewAngle] = useState<"perspective" | "side" | "front">(defaultView);
  const [visMode, setVisMode] = useState<AvatarVisualizationMode>("clay"); // markers off by default; "rig" is Figure 3 (Kinematic Rig)
  const [controlMode, setControlMode] = useState<AvatarControlMode>("mimic");
  // glb load state; on "error" the procedural clay body below stays visible as a fallback
  const [modelStatus, setModelStatus] = useState<ModelStatus>("loading");
  const [modelProgress, setModelProgress] = useState<number | null>(null);

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

  // Group for the optional kinematic-rig overlay
  const rigOverlayGroupRef = useRef<THREE.Group | null>(null);

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
  }, [exerciseId]);

  /** Schedules a single keyframe phase onto the tween queue. */
  const scheduleKeyframe = useCallback((
    kf: ExerciseKeyframe,
    delayMs: number
  ) => {
    const id = setTimeout(() => {
      const now = performance.now();

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

    // ── 5. Schedule each keyframe as a chained delay ────────────────────────
    // Each keyframe fires after all previous durations have elapsed
    let cumulativeDelay = 0;
    for (const kf of seq.keyframes) {
      scheduleKeyframe(kf, cumulativeDelay);
      cumulativeDelay += kf.durationMs;
    }

    // ── 6. Clear cue overlay after the full sequence ends ───────────────────
    const clearId = setTimeout(() => {
      setCoachCue(null);
      setReplayPhaseLabel(null);
    }, cumulativeDelay + 1200);
    replayTimeoutsRef.current.push(clearId);
  }, [exerciseId, scheduleKeyframe]);



  // Show the rig dots and lines only in "rig" mode
  useEffect(() => {
    const on = visMode === "rig";
    rigOverlayGroupRef.current?.children.forEach((o) => (o.visible = on));
    jointMeshesRef.current.forEach((m) => (m.visible = on));
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
    // No scene background: the canvas is transparent so the card's own surface colour shows through

    const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 50);
    camera.position.set(0, 1.0, 3.4);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    rendererRef.current = renderer;
    mount.appendChild(renderer.domElement);

    const orbitGroup = new THREE.Group();
    orbitGroupRef.current = orbitGroup;
    scene.add(orbitGroup);

    // Overlay group for the Kinematic Skeleton
    const rigOverlayGroup = new THREE.Group();
    rigOverlayGroupRef.current = rigOverlayGroup;
    orbitGroup.add(rigOverlayGroup);

    // Studio Lighting setup to sculpt anatomical muscle contours
    // Soft, even base light: sky/ground hemisphere instead of flat ambient
    const ambientLight = new THREE.HemisphereLight(0xf4f6fa, 0x6b7280, 0.85);
    scene.add(ambientLight);

    // Key light (angled high front-right)
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.05);
    keyLight.position.set(2.4, 4.0, 3.2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.radius = 5;
    keyLight.shadow.bias = -0.0004;
    scene.add(keyLight);

    // Fill light (softer cool light from left)
    const fillLight = new THREE.DirectionalLight(0xc8d4e6, 0.55);
    fillLight.position.set(-2.8, 2.0, 2.2);
    scene.add(fillLight);

    // Rim back-light (creates crisp silhouette seen in anatomical reference scans)
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.7);
    rimLight.position.set(0, 2.8, -3.2);
    scene.add(rimLight);

    // Image-based light so glb PBR materials (metalness, clearcoat, ...) don't render black
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;
    scene.environmentIntensity = 0.45;
    pmrem.dispose();

    // Floor pedestal in the site's "sand" tone
    const floorGeo = new THREE.CircleGeometry(1.4, 64);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xddd3c0, // sand
      roughness: 0.95,
      metalness: 0.0,
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
      color: 0xaeb4bd, // Light neutral grey
      roughness: 0.68,
      metalness: 0.0,
    });

    // Darker tone for muscular crevices and contours
    const contourMat = new THREE.MeshStandardMaterial({
      color: 0x9aa1ab,
      roughness: 0.7,
      metalness: 0.0,
    });

    // Kinematic rig overlay, in the site's forest / blue-grey tones
    const rigJointMat = new THREE.MeshStandardMaterial({
      color: 0x1f4a2e, // forest
      roughness: 0.3,
      metalness: 0.0,
    });

    const rigLineMat = new THREE.LineBasicMaterial({
      color: 0x5f829a, // good
      linewidth: 2,
    });

    // Bone hierarchy (segment lengths) is shared with the replay library and ground-contact solver
    const bones = buildRigSkeleton();
    const jointMeshes = new Map<string, THREE.Mesh>();

    const makeJoint = (name: string, radius = 0.026) => {
      const geo = new THREE.SphereGeometry(radius, 16, 16);
      const mesh = new THREE.Mesh(geo, rigJointMat.clone());
      mesh.renderOrder = 2;
      jointMeshes.set(name, mesh);
      rigOverlayGroup.add(mesh);
      return mesh;
    };

    // Helper for kinematic bone connection lines
    const linkKinematicBones = (objA: THREE.Object3D, objB: THREE.Object3D) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        new THREE.Vector3(),
      ]);
      const line = new THREE.Line(geo, rigLineMat);
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
    const pelvisGeo = new THREE.CylinderGeometry(0.145, 0.128, 0.16, 48, 4);
    pelvisGeo.scale(1.12, 1.0, 0.88);
    const pelvisMesh = new THREE.Mesh(pelvisGeo, clayMat);
    pelvisMesh.position.set(0, -0.015, 0);
    pelvisMesh.castShadow = true;
    hips.add(pelvisMesh);

    // 2. Spine (Lumbar / Abdomen)
    const spine = bones.get("Spine")!;
    const spineJoint = makeJoint("Spine", 0.024);

    // Abdominal wall with tapered athletic waist
    const lumbarGeo = new THREE.CylinderGeometry(0.138, 0.144, 0.12, 48, 4);
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
    const thoraxGeo = new THREE.CylinderGeometry(0.165, 0.14, 0.19, 48, 6);
    thoraxGeo.scale(1.18, 1.0, 0.82); // broad chest, muscular athletic V-taper
    const thoraxMesh = new THREE.Mesh(thoraxGeo, clayMat);
    thoraxMesh.position.set(0, 0.095, 0.005);
    thoraxMesh.castShadow = true;
    spine1.add(thoraxMesh);

    // Defined Pectoral Major Plates (Left and Right)
    const leftPecGeo = new RoundedBoxGeometry(0.11, 0.08, 0.04, 6, 0.016);
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

    const neckGeo = new THREE.CylinderGeometry(0.046, 0.054, 0.085, 36, 2);
    const neckMesh = new THREE.Mesh(neckGeo, clayMat);
    neckMesh.position.set(0, 0.04, 0);
    neckMesh.castShadow = true;
    neck.add(neckMesh);

    // Head (neutral upright posture with -1.8cm axial cervical retraction)
    const head = bones.get("Head")!;
    headRef.current = head;
    const headJoint = makeJoint("Head", 0.024);

    // Anatomical Cranium & Sculpted Facial Structure
    const craniumGeo = new THREE.SphereGeometry(0.088, 48, 48);
    craniumGeo.scale(0.92, 1.16, 1.04);
    const cranium = new THREE.Mesh(craniumGeo, clayMat);
    cranium.position.set(0, 0.078, 0);
    cranium.castShadow = true;
    head.add(cranium);

    // Sculpted Jawline & Chin
    const jawGeo = new RoundedBoxGeometry(0.054, 0.042, 0.065, 6, 0.015);
    const jaw = new THREE.Mesh(jawGeo, contourMat);
    jaw.position.set(0, 0.025, 0.045);
    jaw.rotation.x = -0.2;
    head.add(jaw);

    // Brow & Nose Bridge Definition
    const browGeo = new RoundedBoxGeometry(0.07, 0.016, 0.03, 6, 0.007);
    const brow = new THREE.Mesh(browGeo, contourMat);
    brow.position.set(0, 0.085, 0.076);
    head.add(brow);

    const noseGeo = new THREE.ConeGeometry(0.016, 0.038, 16);
    noseGeo.rotateX(Math.PI / 4.2);
    const nose = new THREE.Mesh(noseGeo, clayMat);
    nose.position.set(0, 0.064, 0.085);
    head.add(nose);

    // 5. Left Leg (Hip -> Quadriceps -> Knee -> Calf -> Foot)
    const leftUpLeg = bones.get("LeftUpLeg")!;
    const leftHipJoint = makeJoint("LeftUpLeg", 0.026);

    // Anatomical Quadriceps Thigh (broader at top, defined teardrop)
    const thighGeo = new THREE.CapsuleGeometry(0.064, 0.28, 16, 48);
    thighGeo.scale(1.05, 1.0, 1.15); // muscular anterior curve
    const leftThigh = new THREE.Mesh(thighGeo, clayMat);
    leftThigh.position.set(0, -0.18, 0);
    leftThigh.castShadow = true;
    leftUpLeg.add(leftThigh);

    const leftLeg = bones.get("LeftLeg")!;
    const leftKneeJoint = makeJoint("LeftLeg", 0.026);

    // Defined Patella (Kneecap)
    const patellaGeo = new THREE.SphereGeometry(0.032, 24, 24);
    patellaGeo.scale(1.0, 1.1, 0.7);
    const leftPatella = new THREE.Mesh(patellaGeo, contourMat);
    leftPatella.position.set(0, 0, 0.04);
    leftLeg.add(leftPatella);

    // Calf (Gastrocnemius contour tapering to Achilles)
    const calfGeo = new THREE.CapsuleGeometry(0.048, 0.3, 16, 48);
    calfGeo.scale(1.0, 1.0, 1.15); // muscular posterior curve
    const leftCalf = new THREE.Mesh(calfGeo, clayMat);
    leftCalf.position.set(0, -0.19, -0.005);
    leftCalf.castShadow = true;
    leftLeg.add(leftCalf);

    const leftFoot = bones.get("LeftFoot")!;
    const leftAnkleJoint = makeJoint("LeftFoot", 0.022);

    const footGeo = new RoundedBoxGeometry(0.076, 0.055, 0.17, 6, 0.02);
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
    const deltoidGeo = new THREE.SphereGeometry(0.052, 32, 32);
    deltoidGeo.scale(0.9, 1.25, 1.0);
    const leftDeltoid = new THREE.Mesh(deltoidGeo, contourMat);
    leftDeltoid.position.set(-0.01, -0.02, 0);
    leftArm.add(leftDeltoid);

    // Bicep/Tricep Upper Arm
    const bicepGeo = new THREE.CapsuleGeometry(0.042, 0.18, 16, 40);
    const leftBicep = new THREE.Mesh(bicepGeo, clayMat);
    leftBicep.position.set(0, -0.13, 0);
    leftBicep.castShadow = true;
    leftArm.add(leftBicep);

    const leftForeArm = bones.get("LeftForeArm")!;
    const leftElbowJoint = makeJoint("LeftForeArm", 0.024);

    // Forearm
    const forearmGeo = new THREE.CapsuleGeometry(0.036, 0.18, 16, 40);
    const leftForearmMesh = new THREE.Mesh(forearmGeo, clayMat);
    leftForearmMesh.position.set(0, -0.12, 0);
    leftForearmMesh.castShadow = true;
    leftForeArm.add(leftForearmMesh);

    const leftWristJoint = makeJoint("LeftWrist", 0.02);
    leftWristJoint.position.set(0, -0.22, 0);
    leftForeArm.add(leftWristJoint);

    const handGeo = new RoundedBoxGeometry(0.04, 0.07, 0.028, 6, 0.012);
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
    // Silhouette outline: inverted-hull shell per body mesh
    // ========================================================
    const outlineMat = new THREE.MeshBasicMaterial({ color: 0x1c2027, side: THREE.BackSide });
    outlineMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        "vec3 transformed = position + normalize(normal) * 0.0035;"
      );
    };
    const bodyMeshes: THREE.Mesh[] = [];
    orbitGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material === clayMat || m.material === contourMat)) bodyMeshes.push(m);
    });
    bodyMeshes.forEach((m) => {
      const shell = new THREE.Mesh(m.geometry, outlineMat);
      shell.renderOrder = -1;
      m.add(shell);
    });

    // Initial overlay mode visibility
    rigOverlayGroup.children.forEach((o) => (o.visible = visMode === "rig"));
    jointMeshes.forEach((m) => (m.visible = visMode === "rig"));

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

    // ========================================================
    // Blender glb character (async). The logical rig above keeps driving all motion; the glb is
    // retargeted onto it every frame. The procedural clay body is only the loading / error fallback.
    // ========================================================
    let disposed = false;
    let retargeter: GlbRetargeter | null = null;
    let glbRoot: THREE.Object3D | null = null;
    setModelStatus("loading");
    setModelProgress(null);

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(
      AVATAR_MODEL_URL,
      (gltf) => {
        if (disposed) return;
        const model = gltf.scene;
        const glbBones = findGlbBones(model);
        const missing = missingRigBones(glbBones);
        if (missing.length) {
          console.error(`[AvatarCoach3D] ${AVATAR_MODEL_URL} is missing rig bones: ${missing.join(", ")}`);
          setModelStatus("error");
          return;
        }

        model.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          // Skinned bounds are computed at bind pose; posed limbs would get culled
          mesh.frustumCulled = false;
        });

        // Match the logical rig's size (hips height above the floor), then add under the orbit group
        const scale = fitScaleToRig(model, glbBones.get("Hips")!, bones.get("Hips")!.position.y - FLOOR_Y);
        model.scale.setScalar(scale);
        orbitGroup.add(model);
        retargeter = createGlbRetargeter(bones, glbBones, orbitGroup);
        // The character's torso / sleeves are wider than the logical rig, so arms hanging straight down clip into
        // the body. Bake a slight outward tilt into the default pose (after the bind capture, so the glb follows).
        const restAbductDeg = REST_ARM_ABDUCT_DEG;
        (["LeftArm", "RightArm"] as const).forEach((name) => {
          const bone = bones.get(name);
          if (!bone) return;
          const sign = name === "LeftArm" ? -1 : 1;
          bone.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), sign * THREE.MathUtils.degToRad(restAbductDeg)));
          initialQuaternionsRef.current.set(name, bone.quaternion.clone());
        });
        retargeter.update();
        glbRoot = model;

        // Swap the procedural body for the glb. Rig dots/lines must draw through the opaque skin.
        bodyMeshes.forEach((m) => (m.visible = false));
        jointMeshes.forEach((m) => ((m.material as THREE.Material).depthTest = false));
        rigLineMat.depthTest = false;

        setModelStatus("ready");
      },
      (e) => {
        if (!disposed && e.total > 0) setModelProgress(Math.min(1, e.loaded / e.total));
      },
      (err) => {
        console.error(`[AvatarCoach3D] Failed to load ${AVATAR_MODEL_URL}`, err);
        if (!disposed) setModelStatus("error");
      }
    );

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

    let lastFrameMs = performance.now();

    const animate = () => {
      reqIdRef.current = requestAnimationFrame(animate);

      const now = performance.now();
      const dtMs = now - lastFrameMs;
      lastFrameMs = now;
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
            bone?.quaternion.slerp(targetQuat, followFactor(dtMs, MIMIC_TAU_MS));
          });
        }
      }

      if (isMimic && !hasLivePose) {
        // Camera is active but user is momentarily out of frame: gently relax to neutral upright pose
        bonesRef.current.forEach((bone, name) => {
          const initQuat = initialQuaternionsRef.current.get(name);
          if (initQuat) bone.quaternion.slerp(initQuat, followFactor(dtMs, RELAX_TAU_MS));
        });
        headBaseRef.current.quaternion.slerp(identityQuat, followFactor(dtMs, RELAX_TAU_MS));
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

      // 4b. Copy the finished logical pose onto the glb skeleton
      retargeter?.update();

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
      disposed = true;
      retargeter = null;
      if (glbRoot) {
        glbRoot.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((mat) => {
            Object.values(mat).forEach((v) => (v as THREE.Texture)?.isTexture && (v as THREE.Texture).dispose());
            mat.dispose();
          });
        });
      }
      envTexture.dispose();
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
    if (!command) return;

    if (autoPlay && controlMode === "coach") {
      applyCommand(command);
    }
  }, [command, autoPlay, controlMode, applyCommand]);

  const startDemo = () => {
    setControlMode("coach");
    applyCommand(command ?? null);
  };

  return (
    <div className={`relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-slate/[0.07] bg-mist/40 ${className}`}>
      {/* 3D Viewport */}
      <div ref={mountRef} className="relative min-h-[380px] w-full flex-1 cursor-grab active:cursor-grabbing">
        {/* Status chip */}
        <div className={`absolute left-3 top-3 z-10 ${CHIP}`} role="status">
          {controlMode === "mimic" ? (
            cameraOn ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-done/60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-done" />
                </span>
                <span>Live Motion Mirror · 60 FPS</span>
              </>
            ) : (
              <>
                <span className="h-2 w-2 rounded-full bg-warn" />
                <span className="text-stone">Awaiting camera feed</span>
              </>
            )
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-good" />
              <span>Coach guidance demo</span>
            </>
          )}
        </div>

        {/* glb load indicator (the clay placeholder body is visible underneath until it finishes) */}
        {modelStatus === "loading" && (
          <div className={`absolute right-3 top-3 z-10 text-stone ${CHIP}`}>
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone/30 border-t-ink" />
            Loading model{modelProgress !== null ? ` ${Math.round(modelProgress * 100)}%` : "…"}
          </div>
        )}
        {modelStatus === "error" && (
          <div
            className="absolute right-3 top-3 z-10 rounded-full border border-bad/20 bg-bad/10 px-3 py-1 text-[11px] text-bad"
            title={`Could not load ${AVATAR_MODEL_URL}; showing the built-in placeholder body`}
          >
            Model unavailable · placeholder shown
          </div>
        )}

        {/* Coach verbal cue + phase label overlay: shown during replay demos */}
        {coachCue && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20">
            {replayPhaseLabel && (
              <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-forest/15 bg-forest/10 px-2.5 py-0.5 text-[11px] font-medium text-forest">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-forest" />
                {replayPhaseLabel}
              </div>
            )}
            <div className="rounded-xl border border-slate/[0.07] bg-linen/95 px-3 py-2 font-display text-sm italic leading-snug text-slate shadow-soft backdrop-blur-sm">
              {coachCue}
            </div>
          </div>
        )}
      </div>

      {/* Control bar */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-slate/[0.07] bg-linen px-4 py-2.5 text-xs text-stone">
        {/* Tracking mode: live mimicry vs. coach demo */}
        <div className="flex items-center gap-1" role="group" aria-label="Avatar mode">
          <button
            onClick={() => setControlMode("mimic")}
            aria-pressed={controlMode === "mimic"}
            className={`${segment(controlMode === "mimic")} inline-flex items-center gap-1.5`}
            title="Real-time motion mirror"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${cameraOn ? "animate-pulse bg-done" : "bg-stone/50"}`} />
            Mimic Live
          </button>
          <button
            onClick={startDemo}
            aria-pressed={controlMode === "coach"}
            className={segment(controlMode === "coach")}
            title="Demonstrate corrected form"
          >
            Coach Demo
          </button>
        </div>

        {/* Body only, or with the kinematic rig overlay */}
        <div className="flex items-center gap-1" role="group" aria-label="Display">
          <span className="eyebrow mr-1.5 !text-[10px]">Display</span>
          <button onClick={() => setVisMode("clay")} aria-pressed={visMode === "clay"} className={segment(visMode === "clay")} title="Body only">
            Body
          </button>
          <button onClick={() => setVisMode("rig")} aria-pressed={visMode === "rig"} className={segment(visMode === "rig")} title="Show the kinematic skeleton">
            Skeleton
          </button>
        </div>

        {/* Camera angle and actions */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1" role="group" aria-label="Camera angle">
            {([["perspective", "3/4"], ["side", "Side"], ["front", "Front"]] as const).map(([view, label]) => (
              <button key={view} onClick={() => setCameraPreset(view)} aria-pressed={viewAngle === view} className={segment(viewAngle === view)}>
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={startDemo}
            className="rounded-full border border-forest bg-forest px-3 py-0.5 text-[11px] font-medium text-linen transition hover:bg-forest/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest/30"
            title={command ? "Replay a full repetition with corrected form" : "Demonstrate a full repetition with correct form"}
          >
            {command ? "Replay fix" : "Play demo"}
          </button>
          <button
            onClick={resetPose}
            className="rounded-full border border-slate/15 px-2.5 py-0.5 text-[11px] text-stone transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest/30"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
