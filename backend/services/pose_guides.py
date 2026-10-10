"""Geometry and drawing for the exercise pose guides (see scripts/generate_pose_guides.py).

A guide is a photo of a person in an exercise's exact keyframe pose with the skeleton drawn on top.
The pose comes from the reference keyframes (exercises/figure_poses.json); Stable Diffusion + ControlNet
OpenPose renders a person in that pose, and MediaPipe verifies the result before it is accepted.
"""

import math
from dataclasses import dataclass

from PIL import Image, ImageDraw

Point = tuple[float, float]

# OpenPose COCO-18 order, as used by the ControlNet OpenPose model.
NOSE, NECK, R_SHOULDER, R_ELBOW, R_WRIST, L_SHOULDER, L_ELBOW, L_WRIST = range(8)
R_HIP, R_KNEE, R_ANKLE, L_HIP, L_KNEE, L_ANKLE, R_EYE, L_EYE, R_EAR, L_EAR = range(8, 18)

OPENPOSE_LIMBS = [
    (1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10),
    (1, 11), (11, 12), (12, 13), (1, 0), (0, 14), (14, 16), (0, 15), (15, 17),
]
OPENPOSE_COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0),
    (0, 255, 0), (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255),
    (0, 0, 255), (85, 0, 255), (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85),
]

# Figure keypoints use image sides ("l" = image left). Facing the camera, image-left is the person's right.
FIGURE_TO_OPENPOSE = {
    "rS": L_SHOULDER, "rE": L_ELBOW, "rW": L_WRIST, "rH": L_HIP, "rK": L_KNEE, "rA": L_ANKLE,
    "lS": R_SHOULDER, "lE": R_ELBOW, "lW": R_WRIST, "lH": R_HIP, "lK": R_KNEE, "lA": R_ANKLE,
}
FIGURE_HEAD_RADIUS = 6.0

# MediaPipe landmark indices per side.
MP = {
    "left": {"shoulder": 11, "elbow": 13, "wrist": 15, "hip": 23, "knee": 25, "ankle": 27},
    "right": {"shoulder": 12, "elbow": 14, "wrist": 16, "hip": 24, "knee": 26, "ankle": 28},
}
MP_BONES = [
    ("shoulder", "elbow"), ("elbow", "wrist"), ("shoulder", "hip"), ("hip", "knee"), ("knee", "ankle"),
]
MIN_VISIBILITY = 0.5


def _norm(v: Point) -> Point:
    n = math.hypot(*v) or 1.0
    return v[0] / n, v[1] / n


def _add(a: Point, b: Point, k: float = 1.0) -> Point:
    return a[0] + b[0] * k, a[1] + b[1] * k


def angle(a: Point, b: Point, c: Point) -> float:
    """Angle at b, in degrees."""
    v1 = (a[0] - b[0], a[1] - b[1])
    v2 = (c[0] - b[0], c[1] - b[1])
    n = math.hypot(*v1) * math.hypot(*v2)
    if n == 0:
        return 180.0
    return math.degrees(math.acos(max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / n))))


def canvas_size(figure: dict[str, list[float]]) -> tuple[int, int]:
    """Portrait for upright poses, landscape for floor poses (SD 1.5 works best near 512 px)."""
    xs = [p[0] for p in figure.values()]
    ys = [p[1] for p in figure.values()]
    return (640, 512) if max(xs) - min(xs) > max(ys) - min(ys) else (512, 640)


def figure_to_openpose(figure: dict[str, list[float]], view: str, size: tuple[int, int]) -> dict[int, Point]:
    """Maps a reference keyframe to OpenPose keypoints in pixel space, adding a face so the model knows
    which way the head points (side view faces image-right, matching the reference figures)."""
    pts: dict[int, Point] = {FIGURE_TO_OPENPOSE[k]: (v[0], v[1]) for k, v in figure.items() if k in FIGURE_TO_OPENPOSE}
    head = (figure["head"][0], figure["head"][1])
    neck = ((figure["lS"][0] + figure["rS"][0]) / 2, (figure["lS"][1] + figure["rS"][1]) / 2)
    pts[NECK] = neck
    r = FIGURE_HEAD_RADIUS
    up = _norm((head[0] - neck[0], head[1] - neck[1]))
    across = (-up[1], up[0])  # upright: image-right; doubles as the facing direction in side view
    if view == "front":
        pts[NOSE] = _add(head, up, -0.1 * r)
        pts[L_EYE] = _add(_add(head, up, 0.25 * r), across, 0.35 * r)
        pts[R_EYE] = _add(_add(head, up, 0.25 * r), across, -0.35 * r)
        pts[L_EAR] = _add(head, across, 0.8 * r)
        pts[R_EAR] = _add(head, across, -0.8 * r)
    else:
        pts[NOSE] = _add(head, across, 0.9 * r)
        pts[R_EYE] = _add(_add(head, across, 0.55 * r), up, 0.25 * r)
        pts[R_EAR] = _add(head, across, -0.15 * r)

    # Fit into the canvas: centred horizontally, lowest point near the bottom edge.
    w, h = size
    xs = [p[0] for p in pts.values()] + [head[0] - r, head[0] + r]
    ys = [p[1] for p in pts.values()] + [head[1] - r, head[1] + r]
    scale = min(w * 0.8 / max(max(xs) - min(xs), 1), h * 0.84 / max(max(ys) - min(ys), 1))
    ox = (w - (max(xs) - min(xs)) * scale) / 2 - min(xs) * scale
    oy = h * 0.94 - max(ys) * scale
    return {i: (x * scale + ox, y * scale + oy) for i, (x, y) in pts.items()}


def draw_openpose(points: dict[int, Point], size: tuple[int, int]) -> Image.Image:
    """Renders keypoints the way ControlNet OpenPose was trained: coloured limbs on black."""
    img = Image.new("RGB", size, "black")
    d = ImageDraw.Draw(img)
    stick = 4 * max(size) / 512
    for i, (a, b) in enumerate(OPENPOSE_LIMBS):
        if a in points and b in points:
            (x1, y1), (x2, y2) = points[a], points[b]
            length = math.hypot(x2 - x1, y2 - y1) / 2
            rot = math.atan2(y2 - y1, x2 - x1)
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            poly = []
            for t in range(0, 360, 10):
                ex, ey = length * math.cos(math.radians(t)), stick * math.sin(math.radians(t))
                poly.append((cx + ex * math.cos(rot) - ey * math.sin(rot), cy + ex * math.sin(rot) + ey * math.cos(rot)))
            d.polygon(poly, fill=tuple(int(c * 0.6) for c in OPENPOSE_COLORS[i]))
    for i, (x, y) in points.items():
        d.ellipse((x - stick, y - stick, x + stick, y + stick), fill=OPENPOSE_COLORS[i])
    return img


def figure_angles(figure: dict[str, list[float]]) -> dict[str, dict[str, float]]:
    """Joint angles of a reference keyframe, per image side ("l"/"r")."""
    p = {k: (v[0], v[1]) for k, v in figure.items()}
    out = {}
    for s in ("l", "r"):
        out[s] = {
            "elbow": angle(p[f"{s}S"], p[f"{s}E"], p[f"{s}W"]),
            "shoulder": angle(p[f"{s}H"], p[f"{s}S"], p[f"{s}E"]),
            "hip": angle(p[f"{s}S"], p[f"{s}H"], p[f"{s}K"]),
            "knee": angle(p[f"{s}H"], p[f"{s}K"], p[f"{s}A"]),
        }
    return out


def landmark_angles(landmarks: list, width: int, height: int) -> dict[str, dict[str, float]]:
    """Joint angles from MediaPipe landmarks (only joints whose three points are visible), per side."""
    def pt(i: int) -> Point | None:
        lm = landmarks[i]
        return (lm.x * width, lm.y * height) if (lm.visibility or 0) >= MIN_VISIBILITY else None

    out: dict[str, dict[str, float]] = {}
    for side, idx in MP.items():
        triples = {
            "elbow": ("shoulder", "elbow", "wrist"),
            "shoulder": ("hip", "shoulder", "elbow"),
            "hip": ("shoulder", "hip", "knee"),
            "knee": ("hip", "knee", "ankle"),
        }
        out[side] = {}
        for joint, (a, b, c) in triples.items():
            pa, pb, pc = pt(idx[a]), pt(idx[b]), pt(idx[c])
            if pa and pb and pc:
                out[side][joint] = angle(pa, pb, pc)
    return out


def _tilt(dx: float, dy: float) -> float:
    """Torso tilt from upright in degrees: 0 standing, 90 lying, 180 upside down. Mirror-independent."""
    return math.degrees(math.atan2(abs(dx), dy))


def torso_tilt(landmarks: list, width: int, height: int) -> float | None:
    """Tilt of the shoulder-centre → hip-centre line; tells standing from lying down."""
    ids = (11, 12, 23, 24)
    if any((landmarks[i].visibility or 0) < MIN_VISIBILITY for i in ids):
        return None
    sx = (landmarks[11].x + landmarks[12].x) / 2 * width
    sy = (landmarks[11].y + landmarks[12].y) / 2 * height
    hx = (landmarks[23].x + landmarks[24].x) / 2 * width
    hy = (landmarks[23].y + landmarks[24].y) / 2 * height
    return _tilt(hx - sx, hy - sy)


def figure_torso_tilt(figure: dict[str, list[float]]) -> float:
    sx = (figure["lS"][0] + figure["rS"][0]) / 2
    sy = (figure["lS"][1] + figure["rS"][1]) / 2
    hx = (figure["lH"][0] + figure["rH"][0]) / 2
    hy = (figure["lH"][1] + figure["rH"][1]) / 2
    return _tilt(hx - sx, hy - sy)


@dataclass
class PoseMatch:
    error: float  # mean absolute joint-angle error in degrees (inf if the person wasn't clearly detected)
    joints: int


# Facing the camera both sides are visible; side-on, MediaPipe reliably sees only the near side.
MIN_COMPARED_JOINTS = {"front": 5, "side": 3}
MAX_TILT_DIFF = 25


def compare(target: dict[str, dict[str, float]], detected: dict[str, dict[str, float]],
            target_tilt: float, detected_tilt: float | None, view: str = "front") -> PoseMatch:
    """How closely a detected pose matches the target. Sides are matched both ways (the person may face
    either direction), and the torso tilt must agree too (a squat must not come out lying down)."""
    best: PoseMatch = PoseMatch(math.inf, 0)
    for mapping in ({"l": "right", "r": "left"}, {"l": "left", "r": "right"}):
        diffs = [
            abs(angle_t - detected[mapping[s]][joint])
            for s, joints in target.items()
            for joint, angle_t in joints.items()
            if joint in detected[mapping[s]]
        ]
        if len(diffs) >= MIN_COMPARED_JOINTS[view]:
            m = PoseMatch(sum(diffs) / len(diffs), len(diffs))
            if m.error < best.error:
                best = m
    if detected_tilt is None or abs(detected_tilt - target_tilt) > MAX_TILT_DIFF:
        return PoseMatch(math.inf, best.joints)
    return best


GUIDE_LINE = (84, 104, 255)
GUIDE_RING = (255, 255, 255)


def draw_guide_overlay(photo: Image.Image, landmarks: list, view: str) -> Image.Image:
    """Draws the detected skeleton over the photo: blue bones, dots ringed in white.
    In side view only the side facing the camera is drawn (the far side is mostly guessed)."""
    img = photo.convert("RGBA")
    w, h = img.size
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    scale = max(w, h) / 640

    def visible(i: int) -> bool:
        return (landmarks[i].visibility or 0) >= MIN_VISIBILITY

    def px(i: int) -> Point:
        return landmarks[i].x * w, landmarks[i].y * h

    if view == "front":
        sides = ["left", "right"]
    else:
        vis = {s: sum(landmarks[i].visibility or 0 for i in MP[s].values()) for s in MP}
        sides = [max(vis, key=vis.get)]
    bones = [(MP[s][a], MP[s][b]) for s in sides for a, b in MP_BONES]
    if view == "front":
        bones += [(11, 12), (23, 24)]
    joints = sorted({i for bone in bones for i in bone})

    for a, b in bones:
        if visible(a) and visible(b):
            d.line([px(a), px(b)], fill=GUIDE_LINE + (235,), width=max(2, round(3 * scale)))
    for i in joints:
        if visible(i):
            x, y = px(i)
            ring, dot = 11 * scale, 5 * scale
            d.ellipse((x - ring, y - ring, x + ring, y + ring), fill=GUIDE_RING + (70,), outline=GUIDE_RING + (220,), width=max(1, round(1.5 * scale)))
            d.ellipse((x - dot, y - dot, x + dot, y + dot), fill=GUIDE_LINE + (255,))
    return Image.alpha_composite(img, layer).convert("RGB")
