import raw from "@exercises/avatar_corrections.json";
import type { AvatarCommand, BoneName, Vector3D } from "@/types";
import { getExercise } from "./exercises";

interface CorrectionRule {
  highlight_joints: string[];
  actions: {
    bone_name: BoneName;
    target_rotation: Vector3D;
    rotation_mode?: "relative_offset" | "absolute_euler";
    duration_ms?: number;
    easing?: "easeInOutQuad" | "easeOutCubic" | "linear";
  }[];
}

const data = raw as unknown as {
  faults: Record<string, CorrectionRule>;
  exercise_overrides?: Record<string, Record<string, CorrectionRule>>;
};

/** Corrective rules shared with the backend (exercises/avatar_corrections.json). */
export const CANONICAL_AVATAR_RULES = data.faults;

export function getCorrectionRule(faultId: string, exerciseId?: string): CorrectionRule | undefined {
  return (exerciseId && data.exercise_overrides?.[exerciseId]?.[faultId]) || data.faults[faultId];
}

export function getAvatarCommandForFault(
  faultId: string,
  side?: string | null,
  exerciseId?: string
): AvatarCommand | null {
  const rule = getCorrectionRule(faultId, exerciseId);
  if (!rule) return null;

  const fault = exerciseId ? getExercise(exerciseId)?.faults.find((f) => f.id === faultId) : undefined;
  let actions = rule.actions.map((a) => ({
    bone_name: a.bone_name,
    rotation_mode: a.rotation_mode ?? ("relative_offset" as const),
    target_rotation: { ...a.target_rotation },
    duration_ms: a.duration_ms ?? 650,
    easing: a.easing ?? ("easeInOutQuad" as const),
  }));
  let highlights = [...rule.highlight_joints];

  if (side) {
    const opp = side === "left" ? "Right" : "Left";
    actions = actions.filter((a) => !a.bone_name.startsWith(opp));
    highlights = highlights.filter((h) => !h.startsWith(opp));
  }

  return {
    verbal_cue: fault?.cue ?? "",
    primary_fault: faultId,
    highlight_joints: highlights,
    avatar_actions: actions,
  };
}
