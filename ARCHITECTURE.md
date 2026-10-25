# Postura Architecture

Postura is a browser-based form coach. The camera and pose detection run in the browser, so video never
leaves the device. A FastAPI backend phrases spoken cues, speaks them, and stores sessions. A separate
offline script generates the exercise guide photos.

Status as of 10 October 2026. See [README.md](README.md) for how to run it.

## 1. System overview

```
 Browser (Next.js 15, React 18)                          Backend (FastAPI, Python 3.11)
 ─────────────────────────────────────                   ──────────────────────────────────────
 webcam ─► usePoseDetection                              /ws/workout/{user_id}   (WebSocket)
           MediaPipe Pose Landmarker (WASM)                 │  start / issue / praise / rep / end
              │ 33 landmarks per frame                      ▼
              ▼                                          CoachSession (websocket_handler.py)
 WorkoutEngine (utils/workoutEngine.ts)                     ├─ correction_generator ─► Ollama (optional)
   smoothing → metrics → setup gate → RepCounter            ├─ tts_service ─► tts_worker subprocess (pyttsx3)
   → live faults / rep faults → one cue on screen           └─ user_service ─► SQLite / PostgreSQL
              │                                                                 ▲
              ▼                                          REST: /api/exercises, /api/users/{id}/stats,
 UI: VideoPoseContainer, RepCounter, CurrentIssueCard,      /api/users/{id}/sessions, /api/health
     PoseGuide, FormScoreMeter, AICoachOverlay                                  │
              │                                                                 │
 useWebSocket ── sends only detected faults, rep events and session totals ─────┘

 Offline (not part of a workout):
   scripts/generate_pose_guides.py ─► Stable Diffusion + ControlNet OpenPose ─► MediaPipe check ─► frontend/public/guides/
```

The browser decides what is wrong and when a rep counts. The backend decides what to say and when to say it.
The browser sends the backend only the faults it found, never video or raw landmarks.

## 2. Repository layout

| Path | Purpose |
|---|---|
| `exercises/exercises.json` | Single source of truth for all 22 exercises: rep config, fault rules, cues, setup gates, voice lines. Read by the frontend and the backend. |
| `exercises/figure_poses.json` | Reference keyframes for each exercise. Generated from `frontend/src/utils/figurePoses.ts` by `npm run export:figures`. Used by the animated figures and the guide generator. |
| `frontend/src/utils/poseValidation.ts` | Computes metrics (joint angles, torso lean, hip sag, knee tracking, etc.) from landmarks, and evaluates fault rules. |
| `frontend/src/utils/workoutEngine.ts` | The per-frame engine: smoothing, side selection, setup gate, rep judging, live fault debouncing, cue choice, scores. |
| `frontend/src/utils/repCounter.ts` | State machine (start → moving → peak → start) that finds rep candidates. Form is judged by the engine, not here. |
| `frontend/src/hooks/usePoseDetection.ts` | Camera and MediaPipe lifecycle. Loads self-hosted files, falls back to the CDN. |
| `frontend/src/hooks/useWebSocket.ts`, `utils/websocket.ts` | WebSocket client with reconnection and exponential backoff. |
| `frontend/src/hooks/useWorkoutState.ts` | Zustand store for the live workout (reps, hold time, scores, current cue, cue snapshot). |
| `frontend/src/components/PoseGuide.tsx` | Loads the guide photos from the manifest. Falls back to the animated figure. |
| `backend/main.py` | FastAPI app, routes, health check, static audio and error handler. |
| `backend/websocket_handler.py` | Coaching session: cue pacing, delivery, persistence, shielded save on disconnect. |
| `backend/services/correction_generator.py` | Phrases cues with Ollama, caches variants, falls back to the authored cue. |
| `backend/services/tts_service.py`, `tts_worker.py` | Speech synthesis. Each utterance runs in its own short-lived process. |
| `backend/services/user_service.py`, `database.py` | Sessions, cues, reps and stats (SQLAlchemy 2, async). |
| `backend/services/pose_guides.py`, `scripts/generate_pose_guides.py` | Offline guide generation and the joint-angle comparison used to accept or reject a render. |
| `frontend/scripts/setup-mediapipe.mjs` | Copies the MediaPipe WASM files and pose model into `public/mediapipe` on install. |
| `backend/Dockerfile`, `docker-compose.yml` | Container setup: backend, PostgreSQL 16, Ollama. |
| `exercises/ml_spec.json` | Skeleton spec for the form model (joints, window length, normalisation). Read by both the trainer and the browser. |
| `backend/ml/` | Form-model pipeline: `skeleton.py`, `model.py`, `dataset.py`, `train.py`, `export_onnx.py`, `evaluate.py`, `synthetic.py` (smoke tests only). |
| `frontend/src/ml/` | `skeleton.ts` (normalisation), `recorder.ts` (per-rep windows), `formModel.ts` (browser inference), `recordingStore.ts` (IndexedDB labels). |
| `frontend/src/components/RecordPanel.tsx`, `FormModelCard.tsx` | Record-mode labelling and the "AI form check" card. |

## 3. Frontend

**Stack:** Next.js 15.5, React 18.3, TypeScript, Tailwind, Framer Motion 11, Zustand 4.5, MediaPipe Tasks Vision 0.10.35,
Vitest 3.2.7.

**Per-frame pipeline** (`WorkoutEngine.process`):
1. Smooth landmarks and angles with an exponential moving average (`LANDMARK_SMOOTHING`, `METRIC_SMOOTHING`).
2. Pick the judged side. Front-view exercises use both sides. Side-view exercises use the side closer to the camera,
   because MediaPipe mostly guesses the far limbs.
3. Check the camera angle and the setup gate. Shoulder width relative to torso length tells whether you face the camera
   (about 0.8) or are side-on (near 0). Side-view exercises are not judged while you face the camera, and front-view ones
   not while you are side-on; the card says to turn. Then the exercise's own setup (for example, a push-up must be in a
   plank). Nothing counts until both pass. If the angle can't be measured (the far shoulder is hidden) it never blocks.
4. Feed the rep metric to `RepCounter`. On a candidate rep, `judgeRep` decides the outcome.
5. Evaluate live faults. A fault shows only after it has held for 400 ms and clears after 700 ms.
6. Choose one cue to show: major before minor, live before last-rep. Mark it for speech only when it is new.

**Rep acceptance** (`judgeRep`): a rep counts only if all of these hold.
- It reached the count line (`rep.peak_threshold`).
- No `bad` fault was found on the rep, either from its min or max values or from a live `bad` fault held for 3+ frames.
- The body stayed in frame for at least 70% of the rep.
- It wasn't a bounce: at least 400 ms (strength, core and mobility; cardio is exempt, or set `rep.min_duration_ms`).
- It started from the right place, if the exercise sets `rep.start_check` (the shoulder press needs the hands at shoulder
  height, judged from about 300 ms before the movement begins).
- It was one smooth motion: fewer than 2 extra direction changes of 30% of the range (progress is smoothed first, so landmark jitter doesn't count).

Path checks are warnings, never reasons to reject: a `when: "peak"` rule on `wrist_drift` or `wrist_above_shoulder` (the
shoulder press uses `press_drift`) tells a press going up from one going forward, and works without the hips in frame.

Before any of that, the exercise's `body_scope` decides what must be in frame: `upper` (shoulders, elbows, wrists; curls and
presses can be done seated) or `full` (shoulders to ankles). A landmark outside the frame is a guess and counts as unseen,
except above the top edge (hands overhead) and just below the bottom (ankles). Missing parts only pause counting after
about 0.25 s.

Anything else is reported as "Not counted" with a reason. Synthetic problems have their own cue ids (`framed`, `unseen`,
`lost`, `rushed`, `stalled`), and the browser sends the wording it shows so the spoken cue matches the screen. Rules are in `exercises.json`. Each fault has `warn` and `bad`
thresholds. `npm test` checks that the thresholds are ordered correctly for every exercise.

**Exercise types:** `mode: "reps"` (default) counts repetitions. `mode: "hold"` times a position (plank, wall sit,
side plank) and pauses the clock on a major fault.

**Testing:** 145 Vitest tests. They run the engine on synthetic poses with exact joint angles. They check every
exercise's configuration, each fault's behaviour, rep acceptance, holds, and that `figure_poses.json` matches the TypeScript source.

## 4. Backend

**Stack:** Python 3.11, FastAPI 0.141, Uvicorn, SQLAlchemy 2 (async), SQLite by default, PostgreSQL in Docker,
Pydantic 2 settings, httpx, pyttsx3 2.99, Pillow.

**Protocol** (`/ws/workout/{user_id}`, JSON):

| Direction | Message | Meaning |
|---|---|---|
| client → server | `start` | Begin a session for an exercise. |
| client → server | `issue` | A fault the browser detected (`fault_id`, `status`, `side`, `from_rep`). |
| client → server | `praise` | A run of clean reps or a clean hold. |
| client → server | `rep` | A counted or partial rep, for persistence. |
| client → server | `end` | Finish and save the session (reps or seconds held, average score, duration). |
| server → client | `session_started`, `correction`, `voice`, `session_saved`, `error` | Responses and spoken cues. |

**Coaching pacing** (`config.py`): at least 6 s between cues (3 s for a major fault), 15 s before repeating the same
fault, 20 s between encouragements. One cue plays at a time.

**Cue wording:** the authored cue in `exercises.json` is the source of truth. If Ollama is available, it
rephrases the cue into one short spoken sentence, with a system prompt and examples. It keeps up to three variants per
fault and rotates them. If Ollama is down or times out after 25 s, the authored cue is spoken as-is.

**Persistence:** `User`, `WorkoutSession` (reps, or seconds held for holds, average score, duration), and `CoachingCue`
(one row for every cue delivered). `GET /api/users/{id}/stats` returns totals, separating hold seconds from reps,
and the most common faults.

**Tests:** 24 pytest tests cover the WebSocket protocol, session saving, pacing, the LLM prompt and cleanup, the guide
geometry, and the error handler.

## 5. Models and technologies

Status key: **In use** means it runs in the product. **Replaced** means it was tried and removed. **Rejected** means it
was considered and not used. **Optional** means it is supported but not on by default.

### Pose detection

| Model / tool | Status | Where | Notes |
|---|---|---|---|
| MediaPipe Pose Landmarker **lite** (float16) | In use | Browser, WASM, GPU with CPU fallback | 33 landmarks, runs at full frame rate. Self-hosted in `public/mediapipe`, with a CDN fallback. |
| MediaPipe Pose Landmarker **heavy** | In use (offline) | `generate_pose_guides.py` | Checks each generated guide photo. Too slow for live use, which is why the browser uses lite. |
| MediaPipe Python 0.10.35 | In use (offline) | Backend guide generator | Pinned to the same version as the browser. |
| Rule-based fault evaluation (joint angles and metrics) | In use | Browser | Hand-set thresholds in `exercises.json`. This is what decides rep counts today, and it is not accurate enough yet. |
| YOLOv8 Pose / YOLO11 Pose (Ultralytics) | Rejected | | Considered for accuracy. Not tested. Tracks 17 keypoints with no feet, which matters for squats and lunges. Would need the frames sent to a server. |
| **ST-GCN + self-attention rep-form classifier** (own model, 147k parameters) | **Built, not trained on real data** | Browser (`onnxruntime-web`, WebAssembly) | Pipeline, export and browser inference all work and are tested. It has only been trained on synthetic reps, so it is not shipped and has no accuracy figure for real users. See section 6. |

### Language models

| Model / tool | Status | Where | Notes |
|---|---|---|---|
| Ollama + Mistral 7B | Optional | Backend `correction_generator` | Rephrases authored cues. Off by default; the server falls back to the authored cue when it is absent. |
| Vision LLMs (GPT-4V, Claude Vision) for live scoring | Rejected | | Discussed. One to two seconds per frame, costs money, and would send video off the device. Could be used for post-workout review. |

### Speech

| Tool | Status | Where | Notes |
|---|---|---|---|
| pyttsx3 (system voices: NSSpeechSynthesizer on macOS, SAPI5, eSpeak) | In use | `tts_worker.py` | Runs in a subprocess because the macOS driver is not thread-safe. Audio saved as WAV under `backend/static/audio`; files older than 6 hours are deleted. |
| Browser speech synthesis (`window.speechSynthesis`) | In use | `useCoachVoice` | The fallback on every OS. The server sends each spoken line with `url: null` when it can't synthesise (no eSpeak on Linux, TTS off, a failure), and the browser speaks the text. Offline, with no backend, the browser speaks the on-screen cue itself, paced like the server (6 s between cues, 15 s per fault). One player serves both workout layouts. |
| Cloud TTS | Not used | | Not needed while the local voice works. |

### Image generation (exercise guide photos)

This is the part that went through the most attempts.

| Model / tool | Status | What happened |
|---|---|---|
| **stabilityai/sd-turbo** (text-to-image, 4 steps) | **Replaced** | Generated correction illustrations from text only. Images were unclear, with no reliable pose. You could not tell what the exercise was. Removed. |
| **Realistic Vision V5.1** (SD 1.5 fine-tune, no VAE baked in) | **In use** | Base model for the guides. First load crashed: the DPM-Solver scheduler rejected `final_sigmas_type` with DEIS. Fixed by using `dpmsolver++` with midpoint solver. Chosen for photorealism; I did not compare it against other SD 1.5 fine-tunes. Licence: CreativeML OpenRAIL-M. |
| **ControlNet OpenPose v1.1** (`lllyasviel/control_v11p_sd15_openpose`) | **In use** | Forces the person into an exact skeleton pose. This is what fixed the "wrong pose" problem from text-only prompts. |
| **sd-vae-ft-mse** (VAE) | **In use** | Replaces the base VAE. `force_upcast` is set as a precaution against black fp16 decodes; I did not see that failure happen here. |
| Stable Diffusion XL | Not tried | Suggested as higher quality. Slower, and probably too heavy for 8 GB of unified memory. |

Problems hit along the way, and the fixes:
- **Prompts silently truncated:** CLIP reads at most 77 tokens, and the rest is dropped without warning. The
  longest prompt was 87 tokens. The prompt and negative prompt are now checked to stay under the limit.
- **Different people per frame:** Stable Diffusion keeps no identity between images, so one fixed description
  is used for all guides.
- **Props and background clutter:** windows, gym equipment and a shirtless figure appeared in some renders.
  The negative prompt now excludes them. Not fully solved.
- **Pose accepted but looks wrong:** the angle check accepts a render whose joint angles match even when the
  person looks wrong. The push-up finish is still almost flat. Angle checks are necessary but not sufficient.
- **Hugging Face download stalled** at 0 bytes with the accelerated transfer client. Fixed by setting
  `HF_HUB_DISABLE_XET=1`.
- **Side view guesses the far limb:** with only one side visible, the comparison needs three matched joints,
  not five. Front view still needs five.

Generation takes 40 seconds to 8 minutes per attempt on the M3 Mac. Frames are tried with several seeds and the best is kept.

### Other tools

| Tool | Status | Notes |
|---|---|---|
| Vitest 5.0.1 | Failed | Needs Node 22; the machine runs Node 20. Downgraded to Vitest 3.2.7. |
| Ollama in Docker | Optional | `docker-compose.yml` runs it alongside PostgreSQL. |
| PostgreSQL 16 | Optional | SQLite is the default. Set `DATABASE_URL` to switch. |

## 6. Form model (ST-GCN with self-attention)

This replaces nothing yet. The rule engine still decides every rep count and every cue. The model is built so that it
can be trained on real data and then run next to the rules, and it can only add advice, never change a count.

```
 Browser                                                      Backend (offline)
 ───────                                                      ─────────────────
 landmarks → normalizeFrame (torso-centred, scaled, upright)
           → RepRecorder: one window per rep (+6 frames of lead-in)
              ├─► Record mode (?record=1): you label the rep ──► IndexedDB ──► Download reps (JSON)
              │                                                                      │
              │                                                       ml/train.py ◄──┘  (ST-GCN + STSAM)
              │                                                       ml/export_onnx.py → fp32 + INT8 ONNX
              └─► FormModel.read (onnxruntime-web, WASM) ◄── public/models/form/{model_meta.json, *.onnx}
                      └─► "AI form check" card
```

**Skeleton normalisation** (`exercises/ml_spec.json`, `src/ml/skeleton.ts`, `backend/ml/skeleton.py`). Each frame is
re-expressed with the torso centroid as origin, torso length as the unit and the torso rotated to point up, so the
features do not depend on where the person stands, how far from the camera, or camera roll. The two languages are
checked against one golden file, and tests confirm the invariance on the real engine. One deliberate addition: the
torso tilt is kept as a separate input, because removing rotation entirely would make a plank and a standing pose
look identical.

**Model** (`backend/ml/model.py`). 17 joints (including heels and toes), 64-frame windows (each rep resampled to 64
frames, so tempo doesn't matter). Three ST-GCN blocks (graph convolution over the skeleton, then a temporal
convolution), then self-attention across joints within a frame and across frames per joint (STSAM), a learned
per-exercise joint gate, and a head that outputs one probability for every (exercise, fault) pair. 147,388
parameters.

**Training** (`backend/ml/train.py`). Masked multi-label loss (only the exercise's own faults count),
class-balanced, with augmentation: left/right mirror, body-proportion scaling, small rotation, noise, dropped
joints, and temporal crop. Validation splits by person, so one person's reps never appear on both sides. The
report compares the model against the rule engine on the same held-out, human-labelled reps.

**Measured on this Mac** (smoke model, so the numbers describe size and speed only):

| | fp32 | INT8 |
|---|---|---|
| File size | 0.61 MB | 0.24 MB |
| Browser (Chrome 154, 1 thread, WASM SIMD), per rep | not measured in browser | median 4.6 ms, p95 5.2 ms |
| Node, same runtime: per rep / load | 4.0 ms / 146 ms | 4.6 ms / 23 ms |
| Difference from PyTorch's output | 2e-5 | 1e-7 vs Python's INT8 run |

INT8 is 2.6 times smaller and loads faster, but it is not faster per inference on WebAssembly. It runs once per rep,
so the browser defaults to INT8 and falls back to fp32 if it fails to load. On the synthetic data it made the same
decisions as fp32 (0 of 282 differ); that needs re-checking on real data.

**Deviations from the original proposal**
- *Not replacing the rules yet.* A trained model is only as good as its labels, and the project has none. The rules stay
  as the gate and the fallback until the model beats them on held-out reps.
- *"1.8–3.5 MB" and "sub-10 ms"* were figures for a different model. This one is 0.24 MB and 4.6 ms, measured.
- *Bench presses* aren't an exercise in the app, so no bench-specific attention was built. Joint relevance is learned
  per exercise by the gate and the attention.

**What is still missing: real data.** To train, record reps in the app (`/workout/<exercise>?record=1`), label each
one (G = good, 1–9 toggles a fault, Enter saves), download the file, and put it in `backend/ml/data/recordings/`.
Rough guide: 100 or more labelled reps per fault, from several people, in several rooms and camera positions, plus
plenty of good reps. Until there is a model in `frontend/public/models/form/`, the app behaves exactly as before.

**Safeguards**
- A model exported with `--synthetic` refuses to load in a production build, and the card warns in development.
- A model trained on a different skeleton spec version is ignored.
- The export script aborts if the ONNX output differs from PyTorch by more than 1e-3. It caught a real bug of mine:
  `torch.onnx.export` puts the model back into training mode afterwards, which made the first parity check wrong.
- Every model failure is caught and logged; a workout never breaks because of the model.

## 7. Known gaps

- **The form model has no real training data**, so it is not used. Collecting labelled reps is the next step.
- **Rep counting is not accurate yet.** The thresholds are estimates. They need real recordings to tune. The debug
  log in `workoutEngine.ts` prints each rep's measurements to the console to support this.
- **Guide photos:** two frames need replacing (the push-up finish and the push-up start skeleton placement). Some
  frames include props.
- **Ollama is not running by default**, so cues use the authored wording.
- **Side view depends on the camera:** if the camera is too far, the near-side joints can drop out of view and reps get "Not counted".
- **No authentication:** user IDs are anonymous, stored in the browser.
- **Pose data is not stored**, so it cannot be used to retrain anything yet.

## 8. Decisions and why

- **Pose detection in the browser:** privacy (video never leaves the device) and no server cost. The trade-off is
  a smaller model, MediaPipe lite, than a server could run.
- **Faults decided in the browser:** the browser has full frame rate and the smoothed landmarks, so it can judge
  faults and reps accurately. The backend only receives events.
- **Authored cues as the source of truth:** a language model should never decide what is wrong, only how
  to say it. Keeping the cues in `exercises.json` also makes them reviewable.
- **Guide photos generated offline:** generating an image takes minutes, so it can't run during a workout.
- **Single `exercises.json`:** the browser and the server must agree on fault IDs and thresholds.
