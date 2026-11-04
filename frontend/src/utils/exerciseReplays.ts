import * as THREE from "three";
import type { AvatarCommand, Vector3D } from "@/types";
import { eulerDegToQuaternion } from "./avatarRig";
import type { GroundAnchor } from "./avatarRig";
import { getCorrectionRule } from "./avatarCorrections";
import { getExercise } from "./exercises";

export interface ExerciseKeyframe {
  phase: "setup" | "movement" | "peak" | "return";
  phaseLabel: string;
  durationMs: number;
  easing: "easeInOutQuad" | "easeOutCubic" | "linear";
  /** Absolute Euler degrees for every bone (see avatarRig.ts for sign conventions). */
  boneRotations: Partial<Record<string, Vector3D>>;
  highlightJoints?: string[];
  cue: string;
}

export interface ExerciseReplaySequence {
  exerciseId: string;
  faultId?: string;
  verbalCue: string;
  highlightJoints: string[];
  /** How the avatar stays planted while it moves (feet, hands, knees, or the pelvis). */
  anchor: GroundAnchor;
  keyframes: ExerciseKeyframe[];
}

// ── Pose authoring ──────────────────────────────────────────────────────────
// Poses are written in anatomical terms and resolved into bone Euler angles, so
// left/right mirroring and sign conventions live in one place.

interface LimbSpec {
  /** Forward raise in degrees (negative = extend behind the body). */
  flex?: number;
  /** Raise away from the midline. */
  abd?: number;
  /** Rotation about the limb's parent vertical axis; positive turns the limb outward. */
  twist?: number;
}

interface PoseSpec {
  hips?: Partial<Vector3D>;
  spine?: number;
  chest?: number;
  neck?: number;
  head?: number;
  arm?: LimbSpec;
  leftArm?: LimbSpec;
  rightArm?: LimbSpec;
  elbow?: number;
  leftElbow?: number;
  rightElbow?: number;
  leg?: LimbSpec;
  leftLeg?: LimbSpec;
  rightLeg?: LimbSpec;
  knee?: number;
  leftKnee?: number;
  rightKnee?: number;
  /** Ankle plantar-flexion in degrees, or "flat" to keep the sole level with the floor. */
  foot?: number | "flat";
  leftFoot?: number | "flat";
  rightFoot?: number | "flat";
}

const NEUTRAL_ARM: LimbSpec = { abd: 8 };
const NEUTRAL_ELBOW = 8;

/** Ankle rotation that leaves the sole level with the floor, toes pointing where the thigh is turned. */
function flatFootRotation(hips: Vector3D, upLeg: Vector3D, knee: number): Vector3D {
  const shinWorld = eulerDegToQuaternion(hips).multiply(eulerDegToQuaternion(upLeg)).multiply(eulerDegToQuaternion({ x: knee, y: 0, z: 0 }));
  const toesWorld = eulerDegToQuaternion({ x: 0, y: hips.y + upLeg.y, z: 0 });
  const e = new THREE.Euler().setFromQuaternion(shinWorld.invert().multiply(toesWorld), "YXZ");
  const deg = THREE.MathUtils.radToDeg;
  return { x: deg(e.x), y: deg(e.y), z: deg(e.z) };
}

export function resolvePose(spec: PoseSpec): Record<string, Vector3D> {
  const hips = { x: 0, y: 0, z: 0, ...spec.hips };
  const out: Record<string, Vector3D> = {
    Hips: hips,
    Spine: { x: spec.spine ?? 0, y: 0, z: 0 },
    Spine1: { x: spec.chest ?? 0, y: 0, z: 0 },
    Neck: { x: spec.neck ?? 0, y: 0, z: 0 },
    Head: { x: spec.head ?? 0, y: 0, z: 0 },
  };

  for (const side of ["Left", "Right"] as const) {
    const s = side === "Left" ? -1 : 1; // abduction / outward twist sign
    const lower = side === "Left" ? "left" : "right";

    const arm = spec[`${lower}Arm`] ?? spec.arm ?? NEUTRAL_ARM;
    out[`${side}Arm`] = { x: -(arm.flex ?? 0), y: s * (arm.twist ?? 0), z: s * (arm.abd ?? 0) };
    out[`${side}ForeArm`] = { x: -(spec[`${lower}Elbow`] ?? spec.elbow ?? NEUTRAL_ELBOW), y: 0, z: 0 };

    const leg = spec[`${lower}Leg`] ?? spec.leg ?? {};
    const upLeg = { x: -(leg.flex ?? 0), y: s * (leg.twist ?? 0), z: s * (leg.abd ?? 0) };
    const knee = spec[`${lower}Knee`] ?? spec.knee ?? 0;
    out[`${side}UpLeg`] = upLeg;
    out[`${side}Leg`] = { x: knee, y: 0, z: 0 };

    const foot = spec[`${lower}Foot`] ?? spec.foot ?? "flat";
    out[`${side}Foot`] = foot === "flat" ? flatFootRotation(hips, upLeg, knee) : { x: foot, y: 0, z: 0 };
  }
  return out;
}

type Phase = ExerciseKeyframe["phase"];

interface ExerciseDemo {
  anchor?: GroundAnchor;
  /** Isometric hold: the last two phases keep the target position. */
  hold?: boolean;
  start: PoseSpec;
  /** Bottom / top of the rep, or the hold position. */
  target: PoseSpec;
  /** Optional second target shown at the peak (e.g. the other leg for high knees). */
  alternate?: PoseSpec;
  labels: Record<Phase, string>;
  cues: Record<Phase, string>;
  highlight: string[];
  durations?: Partial<Record<Phase, number>>;
}

const LEGS = ["LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg"];
const ARMS = ["LeftArm", "RightArm", "LeftForeArm", "RightForeArm"];
const TORSO = ["Hips", "Spine", "Spine1"];

const STAND: PoseSpec = {};

// Floor poses: the body pitch is solved so hands / forearms and toes / knees all reach the floor
// (arms stay vertical at the top; at the bottom the forearms stay vertical under the elbows).
const PUSH_UP_TOP: PoseSpec = { hips: { x: 70.5 }, arm: { flex: 70.5, abd: 12 }, elbow: 0, foot: 0, neck: -10 };
const PUSH_UP_BOTTOM: PoseSpec = { hips: { x: 79.5 }, arm: { flex: 7.5, abd: 30 }, elbow: 72, foot: 0, neck: -12 };
const KNEE_PUSH_UP_TOP: PoseSpec = { hips: { x: 51.5 }, arm: { flex: 51.5, abd: 12 }, elbow: 0, knee: 95, foot: 20, neck: -10 };
const KNEE_PUSH_UP_BOTTOM: PoseSpec = { hips: { x: 66 }, arm: { flex: -6, abd: 30 }, elbow: 72, knee: 95, foot: 20, neck: -12 };
const LUNGE_BOTTOM: PoseSpec = {
  leftLeg: { flex: 88 },
  leftKnee: 92,
  rightLeg: { flex: -14 },
  rightKnee: 98,
  rightFoot: -40,
  arm: { abd: 10 },
};
const SUPINE_KNEES_BENT: PoseSpec = { hips: { x: -90 }, arm: { abd: 10 }, elbow: 0, leg: { flex: 45, abd: 5 }, knee: 109 };

export const EXERCISE_DEMOS: Record<string, ExerciseDemo> = {
  jumping_jack: {
    start: STAND,
    target: { arm: { abd: 165 }, elbow: 4, leg: { abd: 16 }, knee: 6 },
    labels: { setup: "1. Feet together", movement: "2. Jump wide, arms overhead", peak: "3. Full extension", return: "4. Back to centre" },
    cues: {
      setup: "Stand tall, feet together, hands by your sides.",
      movement: "Jump your feet past shoulder width and sweep straight arms overhead.",
      peak: "Hands meet overhead, arms long, soft knees.",
      return: "Land softly as your arms come back down.",
    },
    highlight: ["LeftArm", "RightArm", "LeftUpLeg", "RightUpLeg"],
    durations: { movement: 700, return: 650 },
  },
  squat: {
    start: { leg: { abd: 4, twist: 10 } },
    target: { spine: 22, chest: 12, neck: -14, head: -16, arm: { flex: 126 }, elbow: 4, leg: { flex: 100, abd: 12, twist: 10 }, knee: 118 },
    labels: { setup: "1. Stand tall", movement: "2. Sit back and down", peak: "3. Thighs parallel", return: "4. Drive up" },
    cues: {
      setup: "Feet shoulder-width apart, chest proud, core braced.",
      movement: "Push your hips back and bend your knees, chest up.",
      peak: "Thighs parallel to the floor, knees tracking over toes.",
      return: "Drive through your heels and squeeze your glutes at the top.",
    },
    highlight: LEGS,
  },
  push_up: {
    start: PUSH_UP_TOP,
    target: PUSH_UP_BOTTOM,
    labels: { setup: "1. High plank", movement: "2. Lower with control", peak: "3. Chest near the floor", return: "4. Press up" },
    cues: {
      setup: "Hands under shoulders, one straight line from head to heels.",
      movement: "Bend your elbows back at about 45°, body rigid.",
      peak: "Elbows at 90°, hips level with your shoulders.",
      return: "Press the floor away back to a strong plank.",
    },
    highlight: ["LeftForeArm", "RightForeArm", "Hips", "Spine"],
  },
  knee_push_up: {
    start: KNEE_PUSH_UP_TOP,
    target: KNEE_PUSH_UP_BOTTOM,
    labels: { setup: "1. Kneeling plank", movement: "2. Lower with control", peak: "3. Chest near the floor", return: "4. Press up" },
    cues: {
      setup: "Knees down, hands under shoulders, straight line from head to knees.",
      movement: "Bend your elbows and lower your chest, hips in line.",
      peak: "Elbows at 90°, no bend at the hips.",
      return: "Press back up, keeping the line from head to knees.",
    },
    highlight: ["LeftForeArm", "RightForeArm", "Hips"],
  },
  lunge: {
    anchor: "RightFoot",
    start: STAND,
    target: LUNGE_BOTTOM,
    labels: { setup: "1. Stand tall", movement: "2. Step forward and drop", peak: "3. Both knees at 90°", return: "4. Push back" },
    cues: {
      setup: "Feet hip-width apart, torso upright.",
      movement: "Step forward and lower your back knee toward the floor.",
      peak: "Front thigh parallel, back knee just above the floor, chest tall.",
      return: "Push through the front heel back to standing.",
    },
    highlight: LEGS,
  },
  reverse_lunge: {
    anchor: "LeftFoot",
    start: STAND,
    target: LUNGE_BOTTOM,
    labels: { setup: "1. Stand tall", movement: "2. Step back and drop", peak: "3. Both knees at 90°", return: "4. Return to standing" },
    cues: {
      setup: "Feet hip-width apart, torso upright.",
      movement: "Step back and lower your back knee toward the floor.",
      peak: "Front knee over the ankle, torso upright.",
      return: "Drive through the front heel and bring the back foot in.",
    },
    highlight: LEGS,
  },
  side_lunge: {
    start: { leftLeg: { abd: 30, twist: 10 }, rightLeg: { abd: 30 }, arm: { abd: 10 } },
    target: {
      spine: 18,
      chest: 10,
      arm: { flex: 70 },
      leftLeg: { flex: 68, abd: 30, twist: 10 },
      leftKnee: 90,
      rightLeg: { abd: 50 },
      rightKnee: 0,
    },
    labels: { setup: "1. Wide stance", movement: "2. Shift and sit", peak: "3. Deep side lunge", return: "4. Push back to centre" },
    cues: {
      setup: "Feet wide, toes forward, chest tall.",
      movement: "Sit your hips back over one foot as that knee bends.",
      peak: "Bent knee over the toes, the other leg long and straight.",
      return: "Push off the bent leg back to centre.",
    },
    highlight: LEGS,
  },
  sumo_squat: {
    start: { leg: { abd: 24, twist: 28 }, knee: 4, arm: { abd: 10 } },
    target: { spine: 8, arm: { flex: 80 }, elbow: 10, leg: { flex: 78, abd: 24, twist: 28 }, knee: 98 },
    labels: { setup: "1. Wide stance, toes out", movement: "2. Sit straight down", peak: "3. Deep sumo", return: "4. Stand tall" },
    cues: {
      setup: "Feet well past shoulder width, toes turned out.",
      movement: "Sit straight down between your heels, knees pushing out.",
      peak: "Knees over toes, torso upright.",
      return: "Drive up and squeeze your glutes.",
    },
    highlight: LEGS,
  },
  wall_sit: {
    hold: true,
    start: STAND,
    target: { leg: { flex: 90 }, knee: 90, arm: { abd: 10 } },
    labels: { setup: "1. Back to the wall", movement: "2. Slide down", peak: "3. Hold at 90°", return: "4. Keep holding" },
    cues: {
      setup: "Back flat against the wall, feet out in front.",
      movement: "Slide down until your thighs are parallel to the floor.",
      peak: "Knees at 90°, back pressed into the wall.",
      return: "Breathe steadily and hold the position.",
    },
    highlight: LEGS,
    durations: { peak: 1600, return: 1000 },
  },
  hip_hinge: {
    start: STAND,
    target: { hips: { x: 68 }, neck: -22, head: -10, arm: { flex: 68 }, elbow: 0, leg: { flex: 84 }, knee: 20 },
    labels: { setup: "1. Stand tall", movement: "2. Push hips back", peak: "3. Hamstring stretch", return: "4. Squeeze up" },
    cues: {
      setup: "Feet hip-width, soft knees, long spine.",
      movement: "Push your hips back as your chest tips forward, back flat.",
      peak: "Flat back, soft knees, hands near the knees.",
      return: "Drive your hips forward to stand tall.",
    },
    highlight: ["Hips", "Spine", "LeftUpLeg", "RightUpLeg"],
  },
  bent_over_row: {
    start: { hips: { x: 45 }, neck: -20, arm: { flex: 45 }, elbow: 0, leg: { flex: 62 }, knee: 25 },
    target: { hips: { x: 45 }, neck: -20, arm: { flex: -32, abd: 10 }, elbow: 77, leg: { flex: 62 }, knee: 25 },
    labels: { setup: "1. Hinged, arms long", movement: "2. Row", peak: "3. Elbows past ribs", return: "4. Lower with control" },
    cues: {
      setup: "Hinge forward about 45°, flat back, arms hanging.",
      movement: "Pull your elbows back toward your hips.",
      peak: "Squeeze your shoulder blades, elbows past your ribs.",
      return: "Lower slowly without standing up.",
    },
    highlight: ARMS,
  },
  bicep_curl: {
    start: { arm: { abd: 6 }, elbow: 8 },
    target: { arm: { flex: 6, abd: 6 }, elbow: 140 },
    labels: { setup: "1. Elbows pinned", movement: "2. Curl", peak: "3. Squeeze at the top", return: "4. Lower slowly" },
    cues: {
      setup: "Elbows tucked at your sides, torso still.",
      movement: "Curl your forearms up; only the elbows move.",
      peak: "Full curl, upper arms still vertical.",
      return: "Lower under control to straight arms.",
    },
    highlight: ["LeftForeArm", "RightForeArm"],
  },
  shoulder_press: {
    start: { arm: { flex: 90, twist: 90 }, elbow: 90 },
    target: { arm: { flex: 170, twist: 90 }, elbow: 2 },
    labels: { setup: "1. Weights at shoulders", movement: "2. Press up", peak: "3. Lockout overhead", return: "4. Lower to shoulders" },
    cues: {
      setup: "Elbows out at shoulder height, forearms vertical.",
      movement: "Press straight up, ribs down.",
      peak: "Arms fully straight, biceps by your ears.",
      return: "Lower back to shoulder height with control.",
    },
    highlight: ARMS,
  },
  lateral_raise: {
    start: { arm: { abd: 12 }, elbow: 10 },
    target: { arm: { abd: 90 }, elbow: 12 },
    labels: { setup: "1. Arms by your sides", movement: "2. Raise out wide", peak: "3. Shoulder height", return: "4. Lower slowly" },
    cues: {
      setup: "Soft elbows, shoulders down.",
      movement: "Lift your arms out to the sides.",
      peak: "Stop at shoulder height — no shrugging.",
      return: "Lower slowly back to your sides.",
    },
    highlight: ["LeftArm", "RightArm"],
  },
  front_raise: {
    start: { arm: { abd: 6 }, elbow: 8 },
    target: { arm: { flex: 90, abd: 6 }, elbow: 8 },
    labels: { setup: "1. Arms by your sides", movement: "2. Raise in front", peak: "3. Shoulder height", return: "4. Lower slowly" },
    cues: {
      setup: "Stand tall, arms long in front of your thighs.",
      movement: "Lift straight arms in front of you.",
      peak: "Hands at shoulder height, torso still.",
      return: "Lower with control, no swinging.",
    },
    highlight: ["LeftArm", "RightArm"],
  },
  overhead_tricep_extension: {
    start: { arm: { flex: 168, abd: 6 }, elbow: 138 },
    target: { arm: { flex: 168, abd: 6 }, elbow: 2 },
    labels: { setup: "1. Weight behind head", movement: "2. Extend", peak: "3. Full lockout", return: "4. Lower behind head" },
    cues: {
      setup: "Upper arms vertical by your ears, elbows pointing up.",
      movement: "Straighten your elbows; only the forearms move.",
      peak: "Arms fully straight overhead.",
      return: "Lower the weight behind your head slowly.",
    },
    highlight: ["LeftForeArm", "RightForeArm"],
  },
  high_knees: {
    start: STAND,
    target: { leftLeg: { flex: 92 }, leftKnee: 95, leftFoot: 20, rightArm: { flex: 55 }, rightElbow: 90, leftArm: { flex: -30 }, leftElbow: 90 },
    alternate: { rightLeg: { flex: 92 }, rightKnee: 95, rightFoot: 20, leftArm: { flex: 55 }, leftElbow: 90, rightArm: { flex: -30 }, rightElbow: 90 },
    labels: { setup: "1. Stand tall", movement: "2. Drive one knee up", peak: "3. Switch legs", return: "4. Reset" },
    cues: {
      setup: "Stand tall, core braced.",
      movement: "Drive your knee up to hip height, opposite arm forward.",
      peak: "Switch quickly — knees to hip height, torso upright.",
      return: "Stay light on the balls of your feet.",
    },
    highlight: ["LeftUpLeg", "RightUpLeg"],
    durations: { movement: 500, peak: 600, return: 450 },
  },
  glute_bridge: {
    start: SUPINE_KNEES_BENT,
    target: { hips: { x: -113 }, neck: 12, head: 11, arm: { flex: -23, abd: 10 }, elbow: 0, leg: { flex: 0, abd: 5 }, knee: 113 },
    labels: { setup: "1. Lie back, knees bent", movement: "2. Drive hips up", peak: "3. Full extension", return: "4. Lower down" },
    cues: {
      setup: "Feet flat, hip-width apart, arms by your sides.",
      movement: "Push through your heels and lift your hips.",
      peak: "Straight line from shoulders to knees, glutes squeezed.",
      return: "Lower one vertebra at a time.",
    },
    highlight: ["Hips", "LeftUpLeg", "RightUpLeg"],
  },
  sit_up: {
    start: SUPINE_KNEES_BENT,
    target: { hips: { x: -25 }, spine: 20, chest: 15, arm: { flex: 80 }, elbow: 0, leg: { flex: 110, abd: 5 }, knee: 99.5 },
    labels: { setup: "1. Lie back, knees bent", movement: "2. Curl up", peak: "3. Chest to knees", return: "4. Roll down slowly" },
    cues: {
      setup: "Knees bent, feet flat, arms long by your sides.",
      movement: "Curl your trunk up, reaching toward your knees.",
      peak: "Chest close to your knees, feet stay down.",
      return: "Roll back down with control.",
    },
    highlight: ["Spine", "Spine1"],
  },
  leg_raise: {
    anchor: "hips",
    start: { hips: { x: -90 }, arm: { abd: 10 }, elbow: 0, foot: 10 },
    target: { hips: { x: -90 }, arm: { abd: 10 }, elbow: 0, leg: { flex: 90 }, foot: 10 },
    labels: { setup: "1. Lie flat", movement: "2. Lift straight legs", peak: "3. Legs vertical", return: "4. Lower slowly" },
    cues: {
      setup: "Lie on your back, legs long, lower back pressed down.",
      movement: "Lift your legs together, knees straight.",
      peak: "Legs vertical, lower back still on the floor.",
      return: "Lower slowly without arching your back.",
    },
    highlight: ["LeftUpLeg", "RightUpLeg"],
  },
  plank: {
    hold: true,
    start: { hips: { x: 86 }, spine: -14, arm: { flex: 72, abd: 8 }, elbow: 90, foot: 0, neck: -10, knee: 0 },
    target: { hips: { x: 82 }, arm: { flex: 82, abd: 8 }, elbow: 90, foot: 0, neck: -10, knee: 0 },
    labels: { setup: "1. Forearms down", movement: "2. Brace", peak: "3. One straight line", return: "4. Keep holding" },
    cues: {
      setup: "Elbows under your shoulders, legs straight back.",
      movement: "Squeeze your glutes and brace your core.",
      peak: "Head, hips and heels in one straight line.",
      return: "Breathe steadily, hips level.",
    },
    highlight: TORSO,
    durations: { peak: 1600, return: 1000 },
  },
  side_plank: {
    hold: true,
    start: { hips: { z: -84 }, rightArm: { abd: 74 }, rightElbow: 90, leftArm: { abd: 20 }, leftElbow: 10, foot: 0 },
    target: { hips: { z: -70 }, rightArm: { abd: 70 }, rightElbow: 90, leftArm: { abd: 110 }, leftElbow: 0, foot: 0 },
    labels: { setup: "1. On your side", movement: "2. Lift your hips", peak: "3. One long line", return: "4. Keep holding" },
    cues: {
      setup: "Elbow under your shoulder, feet stacked.",
      movement: "Lift your hips off the floor.",
      peak: "Straight line from head to feet, top arm reaching up.",
      return: "Breathe and keep the hips high.",
    },
    highlight: TORSO,
    durations: { peak: 1600, return: 1000 },
  },
};

// Neutral standing posture drill for head / neck faults
const POSTURE_DEMO: ExerciseDemo = {
  hold: true,
  start: { chest: 8, neck: 16, head: 22 },
  target: { chest: -4, neck: 0, head: 0 },
  labels: {
    setup: "1. Detected: dropped head",
    movement: "2. Lift and retract",
    peak: "3. Ears over shoulders",
    return: "4. Hold neutral",
  },
  cues: {
    setup: "Current posture: head drooping forward, upper back rounded.",
    movement: "Tuck your chin slightly, lift your chest, eyes level.",
    peak: "Neutral alignment: ears directly above your shoulders.",
    return: "Keep this tall posture throughout the exercise.",
  },
  highlight: ["Head", "Neck", "Spine1"],
};

const POSTURE_FAULTS = new Set(["head_down", "forward_head"]);

const DEFAULT_DURATIONS: Record<Phase, number> = { setup: 500, movement: 1000, peak: 600, return: 900 };

function buildFromDemo(
  demo: ExerciseDemo,
  exerciseId: string,
  opts: { faultId?: string; cue?: string; highlights?: string[] } = {}
): ExerciseReplaySequence {
  const start = resolvePose(demo.start);
  const target = resolvePose(demo.target);
  const peak = demo.alternate ? resolvePose(demo.alternate) : target;
  const end = demo.hold ? target : start;
  const durations = { ...DEFAULT_DURATIONS, ...(demo.hold ? { peak: 1400 } : {}), ...demo.durations };
  const highlights = opts.highlights?.length ? opts.highlights : demo.highlight;

  const frame = (phase: Phase, pose: Record<string, Vector3D>, easing: ExerciseKeyframe["easing"], cue: string, hl?: string[]): ExerciseKeyframe => ({
    phase,
    phaseLabel: demo.labels[phase],
    durationMs: durations[phase],
    easing,
    boneRotations: pose,
    highlightJoints: hl,
    cue,
  });

  return {
    exerciseId,
    faultId: opts.faultId,
    verbalCue: opts.cue || demo.cues.movement,
    highlightJoints: highlights,
    anchor: demo.anchor ?? "contacts",
    keyframes: [
      frame("setup", start, "easeOutCubic", demo.cues.setup),
      frame("movement", target, "easeInOutQuad", opts.cue || demo.cues.movement, highlights),
      frame("peak", peak, demo.alternate ? "easeInOutQuad" : "linear", demo.cues.peak, highlights),
      frame("return", end, "easeInOutQuad", demo.cues.return),
    ],
  };
}

/** Builders keyed by exercise id, plus the posture drill keyed by its fault ids. */
export const EXERCISE_REPLAY_SEQUENCES: Record<string, (cue?: string) => ExerciseReplaySequence> = {
  ...Object.fromEntries(
    Object.entries(EXERCISE_DEMOS).map(([id, demo]) => [id, (cue?: string) => buildFromDemo(demo, id, { cue })])
  ),
  head_down: (cue) => buildFromDemo(POSTURE_DEMO, "posture_alignment", { faultId: "head_down", cue }),
  forward_head: (cue) => buildFromDemo(POSTURE_DEMO, "posture_alignment", { faultId: "forward_head", cue }),
};

/** Ground anchor used for an exercise, both for coach demos and the live mirror. */
export function getExerciseAnchor(exerciseId?: string): GroundAnchor {
  return (exerciseId && EXERCISE_DEMOS[exerciseId]?.anchor) || "contacts";
}

/** Exercise that a fault id most likely belongs to, for commands that arrive without one. */
function exerciseForFault(faultId: string): string | undefined {
  return Object.keys(EXERCISE_DEMOS).find((id) => getExercise(id)?.faults.some((f) => f.id === faultId));
}

/**
 * Builds a full repetition demo for an exercise, focused on the command's fault when given:
 * the fault's cue is spoken during the movement and its joints are highlighted. Works with
 * no command at all (plain "how to do it" demo).
 */
export function buildExerciseReplaySequence(
  command?: AvatarCommand | null,
  exerciseId?: string
): ExerciseReplaySequence {
  const faultKey = command?.primary_fault?.toLowerCase() || "";
  const exKey = exerciseId?.toLowerCase() || "";

  if (faultKey && POSTURE_FAULTS.has(faultKey)) {
    return buildFromDemo(POSTURE_DEMO, "posture_alignment", {
      faultId: faultKey,
      cue: command?.verbal_cue,
      highlights: command?.highlight_joints,
    });
  }

  const demoId = EXERCISE_DEMOS[exKey] ? exKey : faultKey ? exerciseForFault(faultKey) : undefined;
  if (demoId) {
    const fault = faultKey ? getExercise(demoId)?.faults.find((f) => f.id === faultKey) : undefined;
    const rule = faultKey ? getCorrectionRule(faultKey, demoId) : undefined;
    return buildFromDemo(EXERCISE_DEMOS[demoId], demoId, {
      faultId: command?.primary_fault,
      cue: command?.verbal_cue || fault?.cue,
      highlights: rule?.highlight_joints ?? command?.highlight_joints,
    });
  }

  // Unknown exercise: animate the command's corrective offsets from a neutral stance
  const cue = command?.verbal_cue || "Correcting form and demonstrating proper movement alignment.";
  const highlights = command?.highlight_joints || [];
  const neutral = resolvePose(STAND);
  const corrected: Record<string, Vector3D> = { ...neutral };
  for (const act of command?.avatar_actions ?? []) {
    const base = neutral[act.bone_name] ?? { x: 0, y: 0, z: 0 };
    corrected[act.bone_name] =
      act.rotation_mode === "absolute_euler"
        ? act.target_rotation
        : { x: base.x + act.target_rotation.x, y: base.y + act.target_rotation.y, z: base.z + act.target_rotation.z };
  }

  return {
    exerciseId: exerciseId || "custom",
    faultId: command?.primary_fault,
    verbalCue: cue,
    highlightJoints: highlights,
    anchor: "contacts",
    keyframes: [
      { phase: "setup", phaseLabel: "1. Setup Position", durationMs: 400, easing: "easeOutCubic", boneRotations: neutral, cue: "Starting from clean neutral stance." },
      { phase: "movement", phaseLabel: "2. Moving to Corrected Form", durationMs: 900, easing: "easeInOutQuad", boneRotations: corrected, highlightJoints: highlights, cue },
      { phase: "peak", phaseLabel: "3. Target Alignment", durationMs: 600, easing: "linear", boneRotations: corrected, highlightJoints: highlights, cue: "Hold target posture and verify joint angles." },
      { phase: "return", phaseLabel: "4. Return to Start", durationMs: 750, easing: "easeInOutQuad", boneRotations: neutral, cue: "Smooth return to neutral position." },
    ],
  };
}
