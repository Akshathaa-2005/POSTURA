export type BoneName =
  | "Hips"
  | "Spine"
  | "Spine1"
  | "Spine2"
  | "Neck"
  | "Head"
  | "LeftUpLeg"
  | "RightUpLeg"
  | "LeftLeg"
  | "RightLeg"
  | "LeftFoot"
  | "RightFoot"
  | "LeftShoulder"
  | "RightShoulder"
  | "LeftArm"
  | "RightArm"
  | "LeftForeArm"
  | "RightForeArm";

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface BoneTransform {
  bone_name: BoneName;
  rotation_mode: "relative_offset" | "absolute_euler";
  target_rotation: Vector3D;
  duration_ms: number;
  easing: "easeInOutQuad" | "easeOutCubic" | "linear";
}

export interface AvatarCommand {
  verbal_cue: string;
  primary_fault: string;
  highlight_joints: string[];
  avatar_actions: BoneTransform[];
}
