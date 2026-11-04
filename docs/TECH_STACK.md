# Postura tech stack: computer vision and LLM

This document explains what Postura is built with and how each part is used, with the most detail on the two
core areas: **computer vision** (section 2) and **language models** (section 3). Operational detail lives in
[ARCHITECTURE.md](../ARCHITECTURE.md); the pose robustness layer has its own [README](../frontend/src/pose/README.md).

Design principle: **video never leaves the browser.** The backend only receives detected faults, rep events and totals.

## 1. Stack at a glance

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (React 18, TypeScript 5.8), Tailwind, Zustand, Framer Motion, Vitest |
| **Computer vision** | MediaPipe Pose Landmarker (`@mediapipe/tasks-vision` 0.10.35, WASM, GPU delegate), onnxruntime-web 1.30 (WebGPU / WASM), YOLO11s-pose (ONNX, dev-only), own ST-GCN model (PyTorch, exported to ONNX) |
| 3D avatar | Three.js, Blender-authored `.glb` character, custom kinematic solver and retargeter |
| Backend | FastAPI, WebSocket, SQLAlchemy 2 async (SQLite default, PostgreSQL optional), httpx, Pydantic |
| **LLM** | Ollama running Mistral 7B, local only (no hosted APIs) |
| Speech | pyttsx3 in a subprocess, WAV output |
| Offline image generation | Stable Diffusion 1.5 (Realistic Vision 5.1) + ControlNet OpenPose, verified by MediaPipe |

## 2. Computer vision

### 2.1 Pose detection (MediaPipe, in the browser)
`usePoseDetection.ts` loads the Pose Landmarker (BlazePose) in `VIDEO` mode with `numPoses: 1`. It returns 33 3D
landmarks with visibility scores. The GPU delegate is tried first and falls back to CPU. The model is self-hosted in
`public/mediapipe` with a CDN fallback; the variant (`lite`, `full`, `heavy`) is set with `NEXT_PUBLIC_POSE_MODEL_VARIANT`
and defaults to `full`, which copes better with occlusion.

### 2.2 Robustness layer (`frontend/src/pose/`)
Raw landmarks jitter and lose joints, so each frame passes through:

1. **`LandmarkSmoother`**: a One-Euro filter (Casiez et al., CHI 2012) per landmark. Heavy smoothing when a joint is
   still (removes jitter), light when it moves fast (keeps latency low). Speed is relative to torso length, so
   behaviour is the same near or far from the camera.
2. **`LandmarkReliability`**: smoothed visibility with hysteresis (on at 0.6, off at 0.4). Crossed limbs (front view)
   and stretched limb segments are dropped.
3. **`GapFiller`**: a briefly unseen joint is placed at `parent_now + (joint - parent)_last_good` for up to 300 ms, at
   visibility 0.55 (above the 0.5 gate, below the trust threshold). Joints dropped for *geometry* are never imputed,
   because the model mis-placed them and their old position isn't a better answer.

### 2.3 From landmarks to coaching (`workoutEngine.ts`, `exercises.json`)
- **Metrics** per frame: joint angles (elbow, knee, hip, shoulder), torso lean, hip sag, stance width, knee tracking,
  hands overhead.
- **View-aware sides:** front view judges both sides; side view judges only the camera-facing side, because the far
  side is mostly guessed by the model.
- **Rep counting** (`RepCounter` plus `judgeRep`): a rep counts only if it reaches the range-of-motion line, has no
  major fault held during it, stays in frame, and has a plausible tempo (`repConstraints.ts` rejects bounces and
  stalls). Otherwise the app says "Not counted" and why.
- **Debouncing:** live faults are confirmed after 400 ms and cleared after 700 ms.
- Everything is data-driven from the shared `exercises/exercises.json` (22 exercises, including timed holds).

### 2.4 Own deep-learning model: ST-GCN with self-attention (`backend/ml/`)
- **Architecture:** 17 joints, 64-frame windows (each rep resampled, so tempo doesn't matter). Three ST-GCN blocks
  (graph convolution over the skeleton, then temporal convolution), self-attention across joints and across frames
  (STSAM), a learned per-exercise joint gate, and a head with one probability per (exercise, fault) pair. 147,388
  parameters.
- **Normalisation:** torso centroid as origin, torso length as unit, torso rotated upright, so the model ignores
  position, distance and camera roll. Torso tilt is kept as a separate input so a plank and a standing pose differ.
  The TypeScript and Python implementations are checked against one golden file.
- **Training:** masked multi-label loss, class-balanced, augmented (mirror, body-proportion scaling, rotation, noise,
  dropped joints, temporal crop). Validation splits by person.
- **Deployment:** exported to ONNX (fp32 and INT8; export aborts if output differs from PyTorch by more than 1e-3) and
  run in the browser with onnxruntime-web, about 4.6 ms per rep for INT8 (0.24 MB).
- **Data collection:** open a workout with `?record=1`, label each rep, download the JSON.
- **Role and status:** it can only add advice and never changes a rep count; failures are caught and logged. **It has
  only been trained on synthetic reps, so it is not shipped and has no accuracy figure for real users.** The pipeline,
  export and browser inference are built and tested; real labelled data is the missing piece.

### 2.5 YOLO11-pose comparison (dev-only)
`pose/yoloPose.ts` runs YOLO11s-pose in the browser (WebGPU, falling back to WASM) with letterboxing, a custom decoder
and a COCO-to-MediaPipe adapter. It is only reachable at `/dev/pose-compare` and is not used by the workout flow.

### 2.6 3D avatar coach driven by CV
- **Mimic mode:** `kinematicSolver.ts` turns live landmarks into bone quaternions, clamped to anatomical joint limits
  and eased with frame-rate-independent smoothing (`followFactor`). It is a custom solver, not a library.
- **Retargeting:** `glbRetarget.ts` drives the Blender `.glb` from an internal logical rig using bind-pose
  differences, so any rest pose works. It detects left/right mirroring between the rig and the glTF.
- **Grounding:** the lowest body point rests on the floor, with contact probes so planted feet don't slide.
- **Rest pose:** upper arms tilt 12° outward (`REST_ARM_ABDUCT_DEG` in `AvatarCoach3D.tsx`) so the sleeves don't clip
  into the torso; reset and relax return to this pose.
- **Coach mode:** a detected fault triggers an avatar command from the backend, and the avatar demonstrates the fix.

### 2.7 Offline CV: guide-photo generation with verification
Reference skeletons are rendered as OpenPose images, and Stable Diffusion 1.5 + ControlNet OpenPose generates a
person in exactly that pose. MediaPipe heavy then checks each render by comparing joint angles with the target over
several seeds, keeping the best and rejecting renders more than 20° off or with two people, missing limbs or a lying
figure. A generative model is therefore verified by a CV model.

## 3. LLM (Ollama, Mistral 7B, local)

### 3.1 Spoken coaching (`backend/services/correction_generator.py`)
**The LLM never diagnoses anything.** The CV and rules engine decide what is wrong, and the exercise database holds
the fix. The LLM only rephrases the authored cue into one short spoken sentence.

- **Prompt:** a persona system prompt (calm trainer), hard constraints (one sentence, at most 16 words, keep the exact
  meaning, body part and side, no new advice, no numbers or emojis), and few-shot examples.
- **Inputs:** the fault label, severity, and a "Measured" line that `describe_deviation` converts to words ("just past
  the limit", "far past the limit"), so the model never does arithmetic on raw numbers. If the ST-GCN also flagged the
  rep, the prompt says so. Earlier wordings are passed as "avoid" lines.
- **Cost and latency:** `num_predict: 48` with a newline stop; three cached variants per (exercise, fault, side,
  severity), rotated.
- **Fallback:** 25 s timeout, then the authored cue. Responses are tagged `source: llm | template | cache`.
- **Pacing:** at least 6 s between cues, 15 s before repeating the same one, 20 s between praise lines.
- **Session summaries** work the same way: facts are computed in code and the LLM only narrates them.

### 3.2 AI workout and diet plan generator (`backend/plans/`)
LLMs write the text; code owns the numbers and the safety.

1. **Profile extraction (LLM):** free text becomes a JSON profile. Keys are included only when clearly stated. User
   text is fenced in `<user_text>` tags and declared to be data (prompt-injection defence).
2. **Safety screen (code, `safety.py`):** deterministic, before the LLM sees anything. Blocking conditions (for
   example heart conditions, eating disorders) get a refusal and a referral to a clinician; flag conditions (for
   example diabetes, hypertension) are allowed with a doctor's-OK flag; unsafe goals (crash diets, steroids) are blocked.
3. **Targets (code, `nutrition.py`):** calories, macros and water are computed, never guessed by the model.
4. **Workout (LLM):** the model picks from a catalogue filtered by injuries, equipment and level. A validating parser
   enforces the exact number of days, repairs or rejects invented exercise IDs, drops exercises banned for the
   person's injuries, fills reps or hold durations from the catalogue, and re-runs the unsafe-output regex.
5. **Meals (LLM):** same pattern, with allergen and diet constraints.
6. **Retries (`llm_service.py`):** when validation fails, the error is fed back to the model for another attempt
   (`PLAN_LLM_ATTEMPTS`). Errors are `LLMUnavailable` (503: server down, model missing, timeout) or `LLMBadOutput` (502).
   Structured output uses Ollama's `/api/chat` with a JSON schema.
7. **Progression:** later weeks adjust sets, reps and duration in code.

Plan exercise IDs are the same as the CV engine's, so a generated plan feeds straight into a camera-coached session.
Plan generation requires Ollama (there is no template fallback).

### 3.3 How CV and LLM fit together
```
camera → MediaPipe → smoothing / reliability → metrics → rules (+ ST-GCN)
      → fault detected → WebSocket → backend
            ├─ Ollama rephrases the authored cue
            ├─ pyttsx3 speaks it
            ├─ avatar command (looked up, then sanitised by KinematicClamper) → 3D coach demonstrates the fix
            └─ logged to the database
```
Avatar commands are **not** generated by the LLM. They come from a canonical correction table and pass through
`KinematicClamper.sanitize`, which keeps the movement anatomically plausible.

### 3.4 Why this design
- Deterministic code makes the safety-critical decisions: diagnosis, numbers, medical screening.
- The LLM handles language, where variety and tone help, and its output is always treated as untrusted.
- Inference is local. Rejected: vision LLMs for live scoring (1–2 s per frame, costly, would upload video) and cloud TTS.

## 4. Known limitations
- The ST-GCN form model has no real training data and is not used.
- Rep counting thresholds are estimates and need real recordings to tune.
- Without Ollama, cues use the authored wording and plan generation returns 503.
- Two SQLite-backed API tests occasionally fail with "database is locked".
- No authentication; user IDs are anonymous and stored in the browser.
