# Postura — AI Pose Coach

Real-time AI fitness coaching with in-browser pose detection. See
`AI Coach - Pose Estimation Platform Architecture.pdf` for the full design.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | MVP frontend (Next.js, MediaPipe, skeleton, form score, reps, dashboard, exercise selection) | ✅ Done |
| 2 | FastAPI backend, WebSocket, Postgres, Ollama corrections, TTS | ✅ Done |
| 3 | Stable Diffusion images, 20+ exercises, task queue | Not started |
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
           ├─ live faults ("always"/"active"/"peak") → confirmed after 400 ms, cleared after 700 ms
           ├─ rep faults ("rep") → judged once when the rep ends (depth, lockout, range)
           └─ one cue on screen: major before minor, live before last-rep
       → canvas skeleton (faulty joints pulse) + dashboard
       → backend (WebSocket): new cue / clean-rep streak / rep / end
            → phrase it (Ollama rephrases the authored cue; falls back to the cue itself)
            → speak it (pyttsx3 → WAV), paced: ≥6 s between cues, 15 s before repeating one
            → log it (coaching_cues table)
```

## Adding an exercise

Add an entry to [`exercises/exercises.json`](exercises/exercises.json) (shared by frontend and backend):

```jsonc
"view": "side",                                  // "front" judges both sides; "side" the camera-facing side
"setup": { "metric": "torso_lean", "op": ">", "value": 55, "cue": "Get into a high plank…" },  // optional
"rep": { "metric": "knee", "direction": "decrease", "start_threshold": 160, "peak_threshold": 110 },
"faults": [
  { "id": "shallow_squat", "label": "Not deep enough",
    "when": "rep", "metric": "knee", "agg": "min",      // judged on the deepest point of each rep
    "op": ">", "warn": 100, "bad": 115,                 // minor beyond 100°, major beyond 115°
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
| `knee_min` | The more-bent knee of the visible legs |

`when`: `always` every frame · `active` while moving · `peak` at the top/bottom of the rep · `rep` once per rep
on its `min`/`max`. `cue_side` (front view) names the side when only one side is at fault.
Add a test for new faults in [`workoutEngine.test.ts`](frontend/src/utils/workoutEngine.test.ts).
