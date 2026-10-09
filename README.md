# AI Coach — Pose Estimation Platform

Real-time AI fitness coaching with in-browser pose detection. See
`AI Coach - Pose Estimation Platform Architecture.pdf` for the full design.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | MVP frontend (Next.js, MediaPipe, skeleton, form score, reps, dashboard, exercise selection) | ✅ Done |
| 2 | FastAPI backend, WebSocket, Postgres, Ollama corrections, TTS | Not started |
| 3 | Stable Diffusion images, 20+ exercises, task queue | Not started |
| 4 | Polish, session summary, auth, deployment | Not started |

## Run locally

```bash
cd frontend
npm install        # also copies MediaPipe WASM + downloads the pose model into public/mediapipe
npm run dev        # http://localhost:3000
```

Camera access needs `localhost` or HTTPS. All video processing happens in the browser.

## How Phase 1 works

```
webcam → usePoseDetection (MediaPipe PoseLandmarker, WASM/GPU)
       → WorkoutEngine (per frame)
           ├─ smooth landmarks (EMA)
           ├─ computeJointAngles   — 8 joints: shoulders, elbows, hips, knees
           ├─ RepCounter           — start → moving → peak → start state machine
           ├─ evaluateFrame        — ideal_angles every frame, peak_angles at the rep peak
           └─ issue debounce       — show after 300 ms, clear after 600 ms of clean form
       → PoseSkeleton canvas (every frame, colour-coded, pulsing problem joints)
       → Zustand store (10 Hz) → dashboard (FormScoreMeter, RepCounter, CurrentIssueCard)
```

## Adding an exercise

Add an entry to [`exercises/exercises.json`](exercises/exercises.json) (shared with the
Phase 2 backend). Joint angles are measured at the middle landmark:

| Joint | Angle between | ~180° means |
|---|---|---|
| `*_shoulder` | hip – shoulder – elbow | arm overhead |
| `*_elbow` | shoulder – elbow – wrist | arm straight |
| `*_hip` | shoulder – hip – knee | torso and thigh in line |
| `*_knee` | hip – knee – ankle | leg straight |

`rep` defines the driving joints and the `start_threshold` / `peak_threshold` angles.
`issue_messages` optionally overrides the default correction text per joint type
(`low` = below the ideal range, `high` = above it).
