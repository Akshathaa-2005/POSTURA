# Postura — AI Pose Coach

Real-time AI fitness coaching with in-browser pose detection. See
`AI Coach - Pose Estimation Platform Architecture.pdf` for the full design.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | MVP frontend (Next.js, MediaPipe, skeleton, form score, reps, dashboard, exercise selection) | ✅ Done |
| 2 | FastAPI backend, WebSocket, Postgres, Ollama corrections, TTS | ✅ Done |
| 3 | 22 exercises incl. timed holds, correction visuals + Stable Diffusion pipeline, LLM prompting, error handling | ✅ Done |
| 4 | Polish, session summary, auth, deployment | Not started |

## Run locally

```bash
# Terminal 1 — backend (http://localhost:8000, API docs at /docs)
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
uvicorn main:app --reload

# Terminal 2 — frontend (http://localhost:3000)
cd frontend
npm install        # also copies MediaPipe WASM + downloads the pose model into public/mediapipe
npm run dev
```

Camera access needs `localhost` or HTTPS. All video and pose processing happens in the browser;
the backend only receives detected faults, rep events and session totals.

**Optional services** — the backend works without them and falls back gracefully:

| Service | Without it | To enable |
|---|---|---|
| Ollama (Mistral 7B) | Template corrections from the exercise database | `brew install ollama && ollama serve`, then `ollama pull mistral` |
| PostgreSQL | SQLite file `backend/ai_coach.db` | `docker compose -f backend/docker-compose.yml up -d db`, then set `DATABASE_URL` in `backend/.env` |
| Backend itself | Frontend still gives full on-device visual feedback | — |

| Pose guide photos | The animated line figure is shown instead | See *Pose guides* below |

Check what's active: `curl localhost:8000/api/health`.

Tests: `cd frontend && npm test` (guidance engine) · `cd backend && .venv/bin/python -m pytest`.

## How guidance works

```
webcam → usePoseDetection (MediaPipe, in-browser)
       → WorkoutEngine, every frame
           ├─ smooth landmarks & metrics (EMA)
           ├─ pick sides: front view → both · side view → the side facing the camera
           │    (the far side is mostly guessed by the model, so it is never judged)
           ├─ metrics: joint angles, torso lean, hip sag, hands overhead, stance width…
           ├─ setup gate (e.g. push-up: must be in a plank before anything counts)
           ├─ RepCounter on the exercise's rep metric; min/max of every rep-fault metric per rep
           ├─ a rep counts only if it reaches the count line, has no major fault held during it,
           │    and stayed in frame; otherwise "Not counted · <reason>"
           ├─ live faults ("always"/"active"/"peak") → confirmed after 400 ms, cleared after 700 ms
           ├─ rep faults ("rep") → judged once when the rep ends (depth, lockout, range)
           └─ one cue on screen: major before minor, live before last-rep
       → canvas skeleton (faulty joints pulse) + dashboard
       → backend (WebSocket): new cue / clean-rep streak / rep / end
            → phrase it (Ollama rephrases the authored cue; falls back to the cue itself)
            → speak it (pyttsx3 → WAV), paced: ≥6 s between cues, 15 s before repeating one
            → log it (coaching_cues table)
```

## Pose guides

Each exercise shows photos of a person in its start and finish positions (or the hold), with the skeleton
drawn on top, on the setup screen and as "Aim for" next to your own pose when a cue appears.

They are generated offline, never during a workout:

1. the reference keyframes ([`exercises/figure_poses.json`](exercises/figure_poses.json), exported from
   `figurePoses.ts` with `npm run export:figures`) are drawn as OpenPose skeletons,
2. Stable Diffusion 1.5 (Realistic Vision 5.1) + ControlNet OpenPose renders a person in exactly that pose,
3. MediaPipe detects the pose in each render and compares joint angles with the target; the best of a few
   seeds wins (it stops early under 10° average joint-angle error); renders more than 20° off, or with two
   people, missing limbs, or lying instead of standing, are rejected and never shown,
4. the detected skeleton is drawn over the photo → `frontend/public/guides/<exercise>/<frame>.jpg` + `manifest.json`.

```bash
cd backend
.venv/bin/pip install -r requirements-images.txt                       # torch, diffusers, mediapipe (~2–3 GB)
.venv/bin/python -m scripts.generate_pose_guides --exercise squat      # one exercise (~2–4 min on an M3)
.venv/bin/python -m scripts.generate_pose_guides                       # everything missing (~1 h first run)
.venv/bin/python -m scripts.generate_pose_guides --exercise plank --force --seeds 6   # retry a weak one
```

Every guide shows the same described coach, because Stable Diffusion doesn't keep identity between images.
The first run downloads ~4 GB of models. Models are CreativeML OpenRAIL-M licensed (commercial use allowed
with use-based restrictions). Without guides, the animated line figure is shown instead.

## Adding an exercise

Add an entry to [`exercises/exercises.json`](exercises/exercises.json) (shared by frontend and backend):

```jsonc
"view": "side",                                  // "front" judges both sides; "side" the camera-facing side
"setup": { "metric": "torso_lean", "op": ">", "value": 55, "cue": "Get into a high plank…" },  // optional
"rep": { "metric": "knee", "direction": "decrease", "start_threshold": 160, "peak_threshold": 100 },
"faults": [
  { "id": "shallow_squat", "label": "Not deep enough",
    "when": "rep", "metric": "knee", "agg": "min",      // judged on the deepest point of each rep
    "op": ">", "warn": 90, "bad": 110,                  // rep counts at ≤100° (rep.peak_threshold);
                                                        // 90–100° counts with a "go deeper" cue
    "cue": "Sink a little deeper — aim for thighs parallel to the floor" }
]
```

| Metric | Meaning |
|---|---|
| `shoulder` / `elbow` / `hip` / `knee` | Joint angle (°) at that joint; ~180° = straight. Shoulder = hip–shoulder–elbow |
| `hands_overhead` | Wrist height above the nose, in torso lengths (+ = above head) |
| `torso_lean` | Torso angle from vertical (°): 0 upright, 90 horizontal |
| `hip_sag` | Hip below (+) / above (−) the shoulder–ankle line, % of body length |
| `stance_width` | Ankle spread ÷ shoulder width |
| `knee_min` / `knee_max` | The more-bent / straighter knee of the visible legs |
| `knee_track` | Knee spread ÷ ankle spread (front view); < 1 = knees caving in |
| `knee_lift_max` | Higher knee's height relative to its hip, in torso lengths (0 = hip height) |

**Thresholds:** `rep.peak_threshold` is the least depth/range that counts. A depth fault's `warn` sits beyond
it (counted, with a minor cue) and its `bad` short of it (explains why a rep wasn't counted); `npm test`
enforces this. Any `bad` fault held during a rep also stops it counting.

Hold exercises (plank, wall sit…) use `"mode": "hold"`, `"hold_target_sec"`, and a `setup` rule that defines the
position; the clock runs only while the position holds without a major fault.

`when`: `always` every frame · `active` while moving · `peak` at the top/bottom of the rep · `rep` once per rep
on its `min`/`max`. `cue_side` (front view) names the side when only one side is at fault.
`npm test` checks every exercise automatically (valid metrics, thresholds in the right order, reachable rep
faults, a figure in [`figurePoses.ts`](frontend/src/utils/figurePoses.ts)); add behaviour tests for new faults in
[`workoutEngine.test.ts`](frontend/src/utils/workoutEngine.test.ts).
