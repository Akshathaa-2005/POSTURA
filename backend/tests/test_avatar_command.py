"""Unit tests for 3D avatar commands and kinematic safety clamping."""

import pytest
from schemas.avatar import (
    AvatarCorrectionCommand,
    BoneTransform,
    KinematicClamper,
    Vector3D,
)
from services import correction_generator as cg
from services.exercises import get_exercise


def test_avatar_command_generation_squat():
    ex = get_exercise("squat")
    cmd = cg.generate_avatar_command(ex, "shallow_squat", "Sink deeper into your squat.")
    assert isinstance(cmd, AvatarCorrectionCommand)
    assert cmd.primary_fault == "shallow_squat"
    assert cmd.verbal_cue == "Sink deeper into your squat."
    assert "LeftLeg" in cmd.highlight_joints
    assert "RightLeg" in cmd.highlight_joints
    assert len(cmd.avatar_actions) >= 2

    # Check that knee action target has positive pitch (flexion)
    knee_action = next(a for a in cmd.avatar_actions if a.bone_name == "LeftLeg")
    assert knee_action.target_rotation.x > 0
    assert knee_action.duration_ms > 0


def test_avatar_command_unilateral_filtering():
    ex = get_exercise("jumping_jack")
    # Left side fault
    cmd_left = cg.generate_avatar_command(ex, "arms_not_overhead", "Raise left arm.", side="left")
    bones_left = [a.bone_name for a in cmd_left.avatar_actions]
    assert "LeftArm" in bones_left
    assert "RightArm" not in bones_left
    assert "RightArm" not in cmd_left.highlight_joints

    # Right side fault
    cmd_right = cg.generate_avatar_command(ex, "arms_not_overhead", "Raise right arm.", side="right")
    bones_right = [a.bone_name for a in cmd_right.avatar_actions]
    assert "RightArm" in bones_right
    assert "LeftArm" not in bones_right


def test_kinematic_clamper_prevents_dislocation():
    # Attempt extreme dislocating rotations (e.g. 180 degrees knee hyperextension or spine twist)
    unsafe_action = BoneTransform(
        bone_name="Spine",
        rotation_mode="relative_offset",
        target_rotation=Vector3D(x=120.0, y=-95.0, z=80.0),
        duration_ms=500,
    )
    clamped = KinematicClamper.clamp_action(unsafe_action)
    # Spine limits: x: (-35, 45), y: (-30, 30), z: (-25, 25)
    assert clamped.target_rotation.x == 45.0
    assert clamped.target_rotation.y == -30.0
    assert clamped.target_rotation.z == 25.0


def test_unknown_fault_fallback():
    ex = get_exercise("squat")
    cmd = cg.generate_avatar_command(ex, "non_existent_fault", "Adjust posture.")
    assert cmd.primary_fault == "non_existent_fault"
    assert len(cmd.avatar_actions) > 0
    assert cmd.avatar_actions[0].bone_name == "Spine"
