import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("PIL")  # pillow ships with requirements-images.txt

from services import pose_guides as pg  # noqa: E402

FIGURES = json.loads((Path(__file__).resolve().parents[2] / "exercises" / "figure_poses.json").read_text())


def landmarks_from_figure(fig, size=(100, 120), mirror=False):
    """Fake MediaPipe landmarks placed exactly on a reference keyframe."""
    lms = [SimpleNamespace(x=0.0, y=0.0, visibility=0.0) for _ in range(33)]
    # Image-left figure points are the person's right side (MediaPipe "right" = 12, 14, …).
    for side, prefix in (("right", "l"), ("left", "r")):
        for joint, key in (("shoulder", "S"), ("elbow", "E"), ("wrist", "W"), ("hip", "H"), ("knee", "K"), ("ankle", "A")):
            x, y = fig[prefix + key]
            if mirror:
                x = size[0] - x
            lms[pg.MP[side][joint]] = SimpleNamespace(x=x / size[0], y=y / size[1], visibility=0.99)
    return lms


def test_openpose_keypoints_fit_the_canvas_and_face_the_right_way():
    for eid, frames in FIGURES.items():
        for fig in frames:
            size = pg.canvas_size(fig)
            pts = pg.figure_to_openpose(fig, "side", size)
            assert all(0 <= x <= size[0] and 0 <= y <= size[1] for x, y in pts.values()), eid
    squat = FIGURES["squat"][0]
    side = pg.figure_to_openpose(squat, "side", (512, 640))
    assert side[pg.NOSE][0] > side[pg.NECK][0]  # profile faces image-right
    front = pg.figure_to_openpose(FIGURES["jumping_jack"][0], "front", (512, 640))
    assert front[pg.R_SHOULDER][0] < front[pg.L_SHOULDER][0]  # facing the camera: person's right on image left
    assert front[pg.R_EYE][0] < front[pg.L_EYE][0]


def test_floor_poses_get_a_landscape_canvas():
    assert pg.canvas_size(FIGURES["plank"][0]) == (640, 512)
    assert pg.canvas_size(FIGURES["squat"][0]) == (512, 640)


def test_control_image_is_drawn():
    img = pg.draw_openpose(pg.figure_to_openpose(FIGURES["squat"][1], "side", (512, 640)), (512, 640))
    assert img.size == (512, 640)
    assert img.getbbox() is not None  # something was drawn on the black canvas


@pytest.mark.parametrize("mirror", [False, True])
def test_matching_pose_scores_near_zero_even_when_mirrored(mirror):
    fig = FIGURES["lunge"][1]
    lms = landmarks_from_figure(fig, mirror=mirror)
    m = pg.compare(pg.figure_angles(fig), pg.landmark_angles(lms, 100, 120), pg.figure_torso_tilt(fig), pg.torso_tilt(lms, 100, 120))
    assert m.error < 1 and m.joints >= 5


def test_wrong_pose_is_penalised():
    target = FIGURES["squat"][1]  # deep squat
    lms = landmarks_from_figure(FIGURES["squat"][0])  # standing
    m = pg.compare(pg.figure_angles(target), pg.landmark_angles(lms, 100, 120), pg.figure_torso_tilt(target), pg.torso_tilt(lms, 100, 120))
    assert m.error > 25


def test_standing_render_for_a_floor_exercise_is_rejected():
    target = FIGURES["plank"][0]
    lms = landmarks_from_figure(FIGURES["squat"][0])
    m = pg.compare(pg.figure_angles(target), pg.landmark_angles(lms, 100, 120), pg.figure_torso_tilt(target), pg.torso_tilt(lms, 100, 120))
    assert m.error == math.inf


def test_too_few_visible_joints_is_rejected():
    fig = FIGURES["squat"][0]
    lms = landmarks_from_figure(fig)
    for i in (13, 14, 15, 16, 25, 26, 27, 28):
        lms[i].visibility = 0.1
    m = pg.compare(pg.figure_angles(fig), pg.landmark_angles(lms, 100, 120), pg.figure_torso_tilt(fig), pg.torso_tilt(lms, 100, 120))
    assert m.error == math.inf
