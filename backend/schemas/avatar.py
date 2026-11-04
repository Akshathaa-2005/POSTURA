"""Pydantic schemas and kinematic safety validation for 3D avatar animation commands."""

import json
from typing import Any, Literal

from pydantic import BaseModel, Field

from config import get_settings

BoneName = Literal[
    "Hips",
    "Spine",
    "Spine1",
    "Spine2",
    "Neck",
    "Head",
    "LeftUpLeg",
    "RightUpLeg",
    "LeftLeg",
    "RightLeg",
    "LeftFoot",
    "RightFoot",
    "LeftShoulder",
    "RightShoulder",
    "LeftArm",
    "RightArm",
    "LeftForeArm",
    "RightForeArm",
]

RotationMode = Literal["relative_offset", "absolute_euler"]
EasingType = Literal["easeInOutQuad", "easeOutCubic", "linear"]


class Vector3D(BaseModel):
    """Euler rotation angles in degrees (X=pitch/sagittal, Y=yaw/transverse, Z=roll/frontal)."""
    x: float = Field(default=0.0, description="Pitch in degrees (-180 to 180)")
    y: float = Field(default=0.0, description="Yaw in degrees (-180 to 180)")
    z: float = Field(default=0.0, description="Roll in degrees (-180 to 180)")


class BoneTransform(BaseModel):
    """A single bone transformation target for the 3D avatar rig."""
    bone_name: BoneName
    rotation_mode: RotationMode = "relative_offset"
    target_rotation: Vector3D
    duration_ms: int = Field(default=800, ge=100, le=3000)
    easing: EasingType = "easeInOutQuad"


class AvatarCorrectionCommand(BaseModel):
    """Full structured command produced by the LLM (or rule fallback) to drive the avatar."""
    verbal_cue: str = Field(..., max_length=120, description="Spoken verbal coaching cue")
    primary_fault: str = Field(..., description="The fault ID being corrected")
    highlight_joints: list[str] = Field(default_factory=list, description="Bones/joints to visually highlight")
    avatar_actions: list[BoneTransform] = Field(default_factory=list, description="Target bone rotations")


class KinematicClamper:
    """Anatomical limit enforcement preventing joint dislocations or unnatural rotations."""

    # Normal human physiological limits (degrees relative to neutral anatomical pose)
    LIMITS: dict[str, dict[str, tuple[float, float]]] = {
        "Hips": {"x": (-30.0, 30.0), "y": (-30.0, 30.0), "z": (-20.0, 20.0)},
        "Spine": {"x": (-35.0, 45.0), "y": (-30.0, 30.0), "z": (-25.0, 25.0)},
        "Spine1": {"x": (-30.0, 35.0), "y": (-25.0, 25.0), "z": (-20.0, 20.0)},
        "Neck": {"x": (-40.0, 40.0), "y": (-50.0, 50.0), "z": (-30.0, 30.0)},
        "LeftUpLeg": {"x": (-130.0, 30.0), "y": (-35.0, 35.0), "z": (-50.0, 40.0)},
        "RightUpLeg": {"x": (-130.0, 30.0), "y": (-35.0, 35.0), "z": (-40.0, 50.0)},
        "LeftLeg": {"x": (-5.0, 150.0), "y": (-15.0, 15.0), "z": (-15.0, 15.0)},
        "RightLeg": {"x": (-5.0, 150.0), "y": (-15.0, 15.0), "z": (-15.0, 15.0)},
        "LeftArm": {"x": (-180.0, 90.0), "y": (-95.0, 95.0), "z": (-180.0, 45.0)},
        "RightArm": {"x": (-180.0, 90.0), "y": (-95.0, 95.0), "z": (-45.0, 180.0)},
        # Elbow flexion is negative X (the forearm swings forward)
        "LeftForeArm": {"x": (-150.0, 5.0), "y": (-20.0, 20.0), "z": (-20.0, 20.0)},
        "RightForeArm": {"x": (-150.0, 5.0), "y": (-20.0, 20.0), "z": (-20.0, 20.0)},
    }

    @classmethod
    def clamp_action(cls, action: BoneTransform) -> BoneTransform:
        lims = cls.LIMITS.get(action.bone_name)
        if not lims:
            return action

        def _clamp(val: float, rng: tuple[float, float]) -> float:
            return max(rng[0], min(rng[1], float(val)))

        rot = action.target_rotation
        rot.x = _clamp(rot.x, lims["x"])
        rot.y = _clamp(rot.y, lims["y"])
        rot.z = _clamp(rot.z, lims["z"])
        return action

    @classmethod
    def sanitize(cls, command: AvatarCorrectionCommand) -> AvatarCorrectionCommand:
        for action in command.avatar_actions:
            cls.clamp_action(action)
        return command


def _load_canonical_corrections() -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, dict[str, Any]]]]:
    """Corrective avatar rules shared with the frontend (exercises/avatar_corrections.json)."""
    path = get_settings().exercises_path.parent / "avatar_corrections.json"
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data["faults"], data.get("exercise_overrides", {})


# Canonical expert biomechanical corrective adjustments for exercise faults
CANONICAL_AVATAR_CORRECTIONS, EXERCISE_AVATAR_OVERRIDES = _load_canonical_corrections()


def get_canonical_correction(exercise_id: str | None, fault_id: str) -> dict[str, Any] | None:
    """The corrective rule for a fault, preferring an exercise-specific override."""
    override = EXERCISE_AVATAR_OVERRIDES.get(exercise_id or "", {}).get(fault_id)
    return override or CANONICAL_AVATAR_CORRECTIONS.get(fault_id)
