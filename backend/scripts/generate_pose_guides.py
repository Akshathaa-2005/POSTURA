"""Generate the exercise pose guides: photos of a person in each keyframe pose with the skeleton overlaid.

    .venv/bin/pip install -r requirements-images.txt
    .venv/bin/python -m scripts.generate_pose_guides --exercise squat      # try one first
    .venv/bin/python -m scripts.generate_pose_guides                       # all missing guides
    .venv/bin/python -m scripts.generate_pose_guides --exercise plank --force --seeds 6 --seed-offset 4

For every exercise keyframe (start and end of the movement; one frame for holds):
  1. the reference skeleton (exercises/figure_poses.json) is drawn as an OpenPose control image,
  2. Stable Diffusion + ControlNet OpenPose renders a person in exactly that pose (several seeds),
  3. MediaPipe detects the pose in each render; the render whose joint angles best match the target wins,
     and renders that drift too far (wrong pose, extra limbs, lying instead of standing) are rejected,
  4. the detected skeleton is drawn over the winner → frontend/public/guides/<exercise>/<frame>.jpg

Results are cached: existing guides are skipped unless --force. A manifest records model, seed, prompt and
pose error for every guide so any image can be reproduced.
"""

import argparse
import json
import logging
import math
import sys
import time
import urllib.request
import zlib
from pathlib import Path

from PIL import Image

from services.exercises import load_exercises
from services.pose_guides import (
    canvas_size,
    compare,
    draw_guide_overlay,
    draw_openpose,
    figure_angles,
    figure_to_openpose,
    figure_torso_tilt,
    landmark_angles,
    torso_tilt,
)

ROOT = Path(__file__).resolve().parents[2]
FIGURES = ROOT / "exercises" / "figure_poses.json"
OUT_DIR = ROOT / "frontend" / "public" / "guides"
CACHE = Path(__file__).resolve().parents[1] / ".cache" / "pose_guides"
DETECTOR_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/"
    "pose_landmarker_heavy.task"
)

BASE_MODEL = "SG161222/Realistic_Vision_V5.1_noVAE"
VAE_MODEL = "stabilityai/sd-vae-ft-mse"
CONTROLNET_MODEL = "lllyasviel/control_v11p_sd15_openpose"
ACCEPT_ERROR = 10.0  # mean joint-angle error (°) below which a render is good enough to stop trying
REJECT_ERROR = 20.0  # above this the render shows a different pose and is never used
# One consistent coach across every guide (Stable Diffusion doesn't keep identity between images).
PERSON = "fit athletic woman with dark hair in a ponytail"

NEGATIVE = (  # under 77 tokens
    "shirtless, bare chest, barefoot, bad feet, bad anatomy, extra limbs, missing limbs, deformed hands, "
    "disfigured face, cropped, blurry, lowres, text, watermark, two people, cartoon, 3d render, nsfw"
)
FLOOR_WORDS = ("plank", "push", "bridge", "sit_up", "leg_raise")
DUMBBELLS = {"bicep_curl", "shoulder_press", "lateral_raise", "front_raise", "overhead_tricep_extension", "bent_over_row"}
# What the skeleton alone can't convey (equipment, contact with the floor), per exercise/frame.
HINTS = {
    ("push_up", "peak"): "chest hovering just above the floor, elbows bent, body straight",
    ("knee_push_up", "peak"): "on knees, chest hovering above the floor, elbows bent",
    ("high_knees", "peak"): "running in place, one knee raised high to hip height",
    ("side_plank", "hold"): "side plank on one forearm, hips lifted, body straight",
}


def build_prompt(exercise: dict, frame: str) -> str:
    """Kept under CLIP's 77-token limit — anything past it is silently dropped."""
    floor = any(w in exercise["id"] for w in FLOOR_WORDS)
    stage = {"start": "starting position", "peak": "end position", "hold": "holding"}[frame]
    view = "facing camera" if exercise["view"] == "front" else "side view"
    extras = [h for h in (HINTS.get((exercise["id"], frame)), "holding dumbbells" if exercise["id"] in DUMBBELLS else None) if h]
    return (
        f"photo of a {PERSON}, {exercise['name'].lower()} {stage}, {view}, full body, "
        + "".join(f"{e}, " for e in extras)
        + "sage green tank top, black leggings, white sneakers, "
        f"{'yoga mat, ' if floor else ''}plain sage studio wall, soft light, sharp focus, realistic"
    )


def keyframes(exercise: dict) -> list[tuple[str, int]]:
    return [("hold", 1)] if exercise.get("mode") == "hold" else [("start", 0), ("peak", 1)]


def load_pipeline():
    import torch
    from diffusers import AutoencoderKL, ControlNetModel, DPMSolverMultistepScheduler, StableDiffusionControlNetPipeline

    if torch.backends.mps.is_available():
        device, dtype = "mps", torch.float16
    elif torch.cuda.is_available():
        device, dtype = "cuda", torch.float16
    else:
        device, dtype = "cpu", torch.float32
    logging.info("Loading models on %s (first run downloads ~4 GB)…", device)
    controlnet = ControlNetModel.from_pretrained(CONTROLNET_MODEL, dtype=dtype, variant="fp16" if dtype == torch.float16 else None)
    vae = AutoencoderKL.from_pretrained(VAE_MODEL, dtype=dtype)
    pipe = StableDiffusionControlNetPipeline.from_pretrained(
        BASE_MODEL, controlnet=controlnet, vae=vae, dtype=dtype, safety_checker=None, requires_safety_checker=False
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(
        pipe.scheduler.config, algorithm_type="dpmsolver++", solver_type="midpoint", use_karras_sigmas=True
    )
    pipe.vae.config.force_upcast = True  # fp16 VAE decoding can produce black images
    pipe = pipe.to(device)
    pipe.enable_attention_slicing()  # fits comfortably in 8 GB unified memory
    pipe.set_progress_bar_config(disable=True)
    return pipe, torch


def load_detector():
    import mediapipe as mp
    import numpy as np
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode

    model = CACHE / "pose_landmarker_heavy.task"
    if not model.exists():
        model.parent.mkdir(parents=True, exist_ok=True)
        logging.info("Downloading the MediaPipe pose model…")
        urllib.request.urlretrieve(DETECTOR_URL, model)
    landmarker = PoseLandmarker.create_from_options(
        PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(model)), running_mode=RunningMode.IMAGE, num_poses=2)
    )

    def detect(img: Image.Image):
        result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(img.convert("RGB"))))
        # Two people (or none) means the render is unusable as a guide.
        return result.pose_landmarks[0] if len(result.pose_landmarks) == 1 else None

    return detect


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--exercise", action="append", help="Only these exercise ids (repeatable)")
    parser.add_argument("--seeds", type=int, default=3, help="Max renders per keyframe (stops early on a good match)")
    parser.add_argument("--frame", action="append", choices=["start", "peak", "hold"], help="Only these keyframes")
    parser.add_argument("--seed-offset", type=int, default=0, help="Skip seeds already tried in an earlier run")
    parser.add_argument("--steps", type=int, default=25)
    parser.add_argument("--force", action="store_true", help="Regenerate existing guides")
    parser.add_argument("--controls-only", action="store_true", help="Only write the OpenPose control images (no SD)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    exercises = load_exercises()
    figures = json.loads(FIGURES.read_text())
    unknown = set(args.exercise or []) - set(exercises)
    if unknown:
        print(f"Unknown exercise ids: {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2

    manifest_path = OUT_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    jobs = [
        (eid, frame, idx)
        for eid, ex in exercises.items()
        if not args.exercise or eid in args.exercise
        for frame, idx in keyframes(ex)
        if not args.frame or frame in args.frame
        if args.force or args.controls_only or not (OUT_DIR / eid / f"{frame}.jpg").exists()
    ]
    print(f"{len(jobs)} guide frames to generate")
    if not jobs:
        return 0

    if args.controls_only:
        for eid, frame, idx in jobs:
            fig, ex = figures[eid][idx], exercises[eid]
            size = canvas_size(fig)
            out = CACHE / "controls" / f"{eid}_{frame}.png"
            out.parent.mkdir(parents=True, exist_ok=True)
            draw_openpose(figure_to_openpose(fig, ex["view"], size), size).save(out)
        print(f"Control images in {CACHE / 'controls'}")
        return 0

    try:
        pipe, torch = load_pipeline()
        detect = load_detector()
    except ImportError as exc:
        print(f"Missing library ({exc.name}) — run: .venv/bin/pip install -r requirements-images.txt", file=sys.stderr)
        return 1

    failed = []
    for n, (eid, frame, idx) in enumerate(jobs, 1):
        ex, fig = exercises[eid], figures[eid][idx]
        size = canvas_size(fig)
        control = draw_openpose(figure_to_openpose(fig, ex["view"], size), size)
        target, target_tilt = figure_angles(fig), figure_torso_tilt(fig)
        base_seed = zlib.crc32(eid.encode())
        prompt = build_prompt(ex, frame)

        best = None
        start = time.monotonic()
        for k in range(args.seeds):
            seed = base_seed + args.seed_offset + k
            photo = pipe(
                prompt,
                image=control,
                negative_prompt=NEGATIVE,
                num_inference_steps=args.steps,
                guidance_scale=7.0,
                controlnet_conditioning_scale=1.0,
                width=size[0],
                height=size[1],
                generator=torch.Generator("cpu").manual_seed(seed),
            ).images[0]
            lms = detect(photo)
            match = compare(target, landmark_angles(lms, *photo.size), target_tilt, torso_tilt(lms, *photo.size), ex["view"]) if lms else None
            err = match.error if match else math.inf
            logging.info("  %s/%s seed %d: pose error %s", eid, frame, seed, f"{err:.1f}°" if err < math.inf else "rejected")
            if best is None or err < best[0]:
                best = (err, seed, photo, lms)
            if err <= ACCEPT_ERROR:
                break

        err, seed, photo, lms = best
        raw = CACHE / "raw" / eid / f"{frame}.png"
        raw.parent.mkdir(parents=True, exist_ok=True)
        photo.save(raw)
        if lms is None or err > REJECT_ERROR:
            failed.append(f"{eid}/{frame}")
            print(f"[{n}/{len(jobs)}] {eid}/{frame}: no render matched the pose — try --seeds 6 (raw best in {raw})")
            continue
        # Upscale before drawing so the overlay lines stay crisp on high-DPI screens.
        big = photo.resize((photo.width * 2, photo.height * 2), Image.LANCZOS)
        out = OUT_DIR / eid / f"{frame}.jpg"
        out.parent.mkdir(parents=True, exist_ok=True)
        draw_guide_overlay(big, lms, ex["view"]).save(out, quality=86, optimize=True)
        manifest.setdefault(eid, {})[frame] = {
            "src": f"/guides/{eid}/{frame}.jpg",
            "width": big.width,
            "height": big.height,
            "pose_error_deg": round(err, 1),
            "seed": seed,
            "prompt": prompt,
            "model": f"{BASE_MODEL} + {CONTROLNET_MODEL}",
        }
        manifest_path.write_text(json.dumps(manifest, indent=1) + "\n")
        print(f"[{n}/{len(jobs)}] {eid}/{frame}: error {err:.1f}° (seed {seed}, {time.monotonic() - start:.0f}s)")

    if failed:
        print(f"\nNeeds another attempt: {', '.join(failed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
