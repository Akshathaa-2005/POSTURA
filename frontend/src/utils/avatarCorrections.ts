import type { AvatarCommand } from "@/types";

export const CANONICAL_AVATAR_COMMANDS: Record<string, Partial<AvatarCommand>> = {
  shallow_squat: {
    primary_fault: "shallow_squat",
    verbal_cue: "Sink a little deeper — aim for thighs parallel to the floor.",
    highlight_joints: ["LeftLeg", "RightLeg", "LeftUpLeg", "RightUpLeg"],
    avatar_actions: [
      {
        bone_name: "LeftUpLeg",
        rotation_mode: "relative_offset",
        target_rotation: { x: -22, y: 0, z: 0 },
        duration_ms: 700,
        easing: "easeInOutQuad",
      },
      {
        bone_name: "RightUpLeg",
        rotation_mode: "relative_offset",
        target_rotation: { x: -22, y: 0, z: 0 },
        duration_ms: 700,
        easing: "easeInOutQuad",
      },
      {
        bone_name: "LeftLeg",
        rotation_mode: "relative_offset",
        target_rotation: { x: 26, y: 0, z: 0 },
        duration_ms: 700,
        easing: "easeInOutQuad",
      },
      {
        bone_name: "RightLeg",
        rotation_mode: "relative_offset",
        target_rotation: { x: 26, y: 0, z: 0 },
        duration_ms: 700,
        easing: "easeInOutQuad",
      },
    ],
  },
  chest_forward: {
    primary_fault: "chest_forward",
    verbal_cue: "Lift your chest — keep your torso tall as you sit back.",
    highlight_joints: ["Spine", "Spine1"],
    avatar_actions: [
      {
        bone_name: "Spine",
        rotation_mode: "relative_offset",
        target_rotation: { x: -18, y: 0, z: 0 },
        duration_ms: 650,
        easing: "easeOutCubic",
      },
      {
        bone_name: "Spine1",
        rotation_mode: "relative_offset",
        target_rotation: { x: -10, y: 0, z: 0 },
        duration_ms: 650,
        easing: "easeOutCubic",
      },
    ],
  },
  hips_sagging: {
    primary_fault: "hips_sagging",
    verbal_cue: "Lift your hips — squeeze your glutes and brace your core.",
    highlight_joints: ["Hips", "Spine"],
    avatar_actions: [
      {
        bone_name: "Hips",
        rotation_mode: "relative_offset",
        target_rotation: { x: 16, y: 0, z: 0 },
        duration_ms: 600,
        easing: "easeInOutQuad",
      },
      {
        bone_name: "Spine",
        rotation_mode: "relative_offset",
        target_rotation: { x: -12, y: 0, z: 0 },
        duration_ms: 600,
        easing: "easeInOutQuad",
      },
    ],
  },
  shallow_push_up: {
    primary_fault: "shallow_push_up",
    verbal_cue: "Lower your chest closer to the floor.",
    highlight_joints: ["LeftForeArm", "RightForeArm", "LeftArm", "RightArm"],
    avatar_actions: [
      {
        bone_name: "LeftForeArm",
        rotation_mode: "relative_offset",
        target_rotation: { x: 28, y: 0, z: 0 },
        duration_ms: 600,
        easing: "easeInOutQuad",
      },
      {
        bone_name: "RightForeArm",
        rotation_mode: "relative_offset",
        target_rotation: { x: 28, y: 0, z: 0 },
        duration_ms: 600,
        easing: "easeInOutQuad",
      },
    ],
  },
  arms_not_overhead: {
    primary_fault: "arms_not_overhead",
    verbal_cue: "Reach all the way up — bring your hands above your head.",
    highlight_joints: ["LeftArm", "RightArm"],
    avatar_actions: [
      {
        bone_name: "LeftArm",
        rotation_mode: "relative_offset",
        target_rotation: { x: 0, y: 0, z: -35 },
        duration_ms: 500,
        easing: "easeOutCubic",
      },
      {
        bone_name: "RightArm",
        rotation_mode: "relative_offset",
        target_rotation: { x: 0, y: 0, z: 35 },
        duration_ms: 500,
        easing: "easeOutCubic",
      },
    ],
  },
  feet_narrow: {
    primary_fault: "feet_narrow",
    verbal_cue: "Jump your feet wider — land well past shoulder width.",
    highlight_joints: ["LeftUpLeg", "RightUpLeg"],
    avatar_actions: [
      {
        bone_name: "LeftUpLeg",
        rotation_mode: "relative_offset",
        target_rotation: { x: 0, y: 0, z: -15 },
        duration_ms: 500,
        easing: "easeOutCubic",
      },
      {
        bone_name: "RightUpLeg",
        rotation_mode: "relative_offset",
        target_rotation: { x: 0, y: 0, z: 15 },
        duration_ms: 500,
        easing: "easeOutCubic",
      },
    ],
  },
  partial_curl: {
    primary_fault: "partial_curl",
    verbal_cue: "Curl the weight all the way up to full flexion.",
    highlight_joints: ["LeftForeArm", "RightForeArm"],
    avatar_actions: [
      {
        bone_name: "LeftForeArm",
        rotation_mode: "relative_offset",
        target_rotation: { x: 35, y: 0, z: 0 },
        duration_ms: 600,
        easing: "easeInOutQuad",
      },
    ],
  },
};

export function getAvatarCommandForFault(faultId: string, side?: string | null): AvatarCommand | null {
  const base = CANONICAL_AVATAR_COMMANDS[faultId];
  if (!base || !base.avatar_actions) return null;

  let actions = [...base.avatar_actions];
  let highlights = [...(base.highlight_joints || [])];

  if (side) {
    const opp = side === "left" ? "Right" : "Left";
    actions = actions.filter((a) => !a.bone_name.startsWith(opp));
    highlights = highlights.filter((h) => !h.startsWith(opp));
  }

  return {
    verbal_cue: base.verbal_cue || "",
    primary_fault: faultId,
    highlight_joints: highlights,
    avatar_actions: actions,
  };
}
