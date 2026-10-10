"""Real-time coaching over a WebSocket.

The browser runs pose detection and fault detection at full frame rate (it has the smoothing and
rep context); this server decides *what the coach says and when*: it phrases cues (Ollama LLM, else
the authored cue), speaks them (TTS), paces them so the coach doesn't nag, and persists the session.

Protocol (JSON messages):
  client → server
    {"type": "start", "exercise_id"}                                   begin a workout session
    {"type": "issue", "fault_id", "status": "warn"|"bad", "side", "from_rep"}
    {"type": "praise"}                                                  a run of clean reps
    {"type": "rep", "event": "rep"|"partial", "reps", "rom"}
    {"type": "end", "reps", "avg_score", "duration_sec"}               finish and persist
  server → client
    {"type": "session_started", "session_id", "exercise_id", "llm", "tts"}
    {"type": "correction", "id", "fault_id", "label", "status", "text", "source"}
    {"type": "voice", "id", "url", "text", "kind": "correction"|"praise"|"intro"}
    {"type": "session_saved", "session_id"}
    {"type": "error", "message"}
"""

import asyncio
import logging
import math
import re
import time
from typing import Any, Literal

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from config import get_settings
from database import SessionLocal
from models import EndMessage, IssueMessage, PraiseMessage, RepMessage, StartMessage
from services import user_service
from services.correction_generator import encouragement, generate_correction, ollama_available
from services.exercises import fault_cue, get_exercise, get_fault
from services.tts_service import text_to_speech, tts_available

log = logging.getLogger(__name__)

USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
VoiceKind = Literal["correction", "praise", "intro"]


class CoachSession:
    def __init__(self, websocket: WebSocket, user_id: str):
        self.ws = websocket
        self.user_id = user_id
        self.settings = get_settings()
        self._send_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()
        self._message_seq = 0
        self._reset()

    def _reset(self) -> None:
        self.session_id: str | None = None
        self.exercise: dict[str, Any] | None = None
        self.started_at = time.monotonic()
        self.reps = 0
        self._last_spoken_at = -math.inf
        self._last_by_fault: dict[str, float] = {}
        self._last_praise_at = -math.inf
        self._busy = False

    async def send(self, payload: dict[str, Any]) -> None:
        async with self._send_lock:
            await self.ws.send_json(payload)

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _next_id(self) -> int:
        self._message_seq += 1
        return self._message_seq

    # ---- message handlers ------------------------------------------------------

    async def handle(self, data: dict[str, Any]) -> None:
        kind = data.get("type")
        handlers = {
            "start": (StartMessage, self.on_start),
            "issue": (IssueMessage, self.on_issue),
            "praise": (PraiseMessage, self.on_praise),
            "rep": (RepMessage, self.on_rep),
            "end": (EndMessage, self.on_end),
        }
        if kind not in handlers:
            await self.send({"type": "error", "message": f"Unknown message type: {kind!r}"})
            return
        model, handler = handlers[kind]
        try:
            msg = model.model_validate(data)
        except ValidationError as exc:
            await self.send({"type": "error", "message": f"Invalid {kind} message: {exc.errors()[0]['msg']}"})
            return
        await handler(msg)

    async def on_start(self, msg: StartMessage) -> None:
        exercise = get_exercise(msg.exercise_id)
        if exercise is None:
            await self.send({"type": "error", "message": f"Unknown exercise: {msg.exercise_id}"})
            return
        if self.session_id:
            await self.finalize()  # a new start implicitly ends the previous session
        self._reset()
        self.exercise = exercise
        async with SessionLocal() as db:
            session = await user_service.start_session(db, self.user_id, exercise["id"], exercise["rep_target"])
        self.session_id = session.id
        tts = tts_available()
        await self.send(
            {
                "type": "session_started",
                "session_id": session.id,
                "exercise_id": exercise["id"],
                "llm": await ollama_available(),
                "tts": tts,
            }
        )
        if tts and exercise.get("voice_intro"):
            self._last_spoken_at = time.monotonic()  # give the intro room before the first correction
            self._spawn(self._speak(exercise["voice_intro"], "intro"))

    async def on_issue(self, msg: IssueMessage) -> None:
        if self.exercise is None:
            await self.send({"type": "error", "message": "Send a start message first"})
            return
        fault = get_fault(self.exercise, msg.fault_id)
        if fault is None:
            await self.send({"type": "error", "message": f"Unknown fault for {self.exercise['id']}: {msg.fault_id}"})
            return
        if self._may_speak(msg.fault_id, msg.status):
            self._spawn(self._deliver_correction(fault, msg))

    async def on_praise(self, _: PraiseMessage) -> None:
        if self.exercise is None:
            return
        now = time.monotonic()
        if (
            not self._busy
            and now - self._last_spoken_at >= self.settings.correction_cooldown_sec
            and now - self._last_praise_at >= self.settings.praise_cooldown_sec
        ):
            self._last_praise_at = self._last_spoken_at = now
            self._busy = True
            self._spawn(self._speak(encouragement(self.exercise), "praise", release=True))

    async def on_rep(self, msg: RepMessage) -> None:
        if not self.session_id:
            return
        self.reps = msg.reps
        async with SessionLocal() as db:
            if msg.event == "partial":
                await user_service.record_partial_rep(db, self.session_id)
            else:
                await user_service.update_reps(db, self.session_id, msg.reps)

    async def on_end(self, msg: EndMessage) -> None:
        self.reps = msg.reps
        session_id = await self.finalize(avg_score=msg.avg_score, duration_sec=msg.duration_sec)
        if session_id:
            await self.send({"type": "session_saved", "session_id": session_id})

    # ---- coaching ----------------------------------------------------------------

    def _may_speak(self, fault_id: str, status: str) -> bool:
        """Paces the coach: one cue at a time, a gap between cues, and no nagging about the same fault."""
        if self._busy:
            return False
        now = time.monotonic()
        # A major fault may interrupt sooner than a minor one.
        gap = self.settings.correction_cooldown_sec * (0.5 if status == "bad" else 1.0)
        if now - self._last_spoken_at < gap:
            return False
        if now - self._last_by_fault.get(fault_id, -math.inf) < self.settings.same_issue_cooldown_sec:
            return False
        self._last_spoken_at = now
        self._last_by_fault[fault_id] = now
        self._busy = True
        return True

    async def _deliver_correction(self, fault: dict[str, Any], msg: IssueMessage) -> None:
        assert self.exercise is not None
        cid = self._next_id()
        session_id = self.session_id
        try:
            cue = fault_cue(self.exercise, fault, msg.side)
            text, source = await generate_correction(
                self.exercise, fault["id"], fault["label"], cue, msg.status, msg.side, msg.from_rep
            )
            await self.send(
                {
                    "type": "correction",
                    "id": cid,
                    "fault_id": fault["id"],
                    "label": fault["label"],
                    "status": msg.status,
                    "text": text,
                    "source": source,
                }
            )
            if session_id:
                async with SessionLocal() as db:
                    await user_service.log_cue(
                        db,
                        session_id,
                        fault_id=fault["id"],
                        label=fault["label"],
                        status=msg.status,
                        side=msg.side,
                        from_rep=msg.from_rep,
                        cue=cue,
                        correction=text,
                        source=source,
                    )
            await self._speak(text, "correction", cid)
        except (WebSocketDisconnect, RuntimeError):
            pass  # client went away mid-correction
        except Exception:
            log.exception("Correction pipeline failed")
        finally:
            self._busy = False

    async def _speak(self, text: str, kind: VoiceKind, cid: int | None = None, release: bool = False) -> None:
        try:
            audio = await text_to_speech(text)
            if audio:
                await self.send({"type": "voice", "id": cid or self._next_id(), "url": f"/audio/{audio}", "text": text, "kind": kind})
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            if release:
                self._busy = False

    # ---- lifecycle ---------------------------------------------------------------

    async def finalize(self, avg_score: float | None = None, duration_sec: float | None = None) -> str | None:
        """Persists the current session (falling back to wall-clock duration if the client didn't send stats)."""
        session_id = self.session_id
        if not session_id:
            return None
        if duration_sec is None:
            duration_sec = time.monotonic() - self.started_at
        async with SessionLocal() as db:
            await user_service.end_session(db, session_id, self.reps, avg_score, duration_sec)
        self.session_id = None
        return session_id

    async def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        try:
            await self.finalize()
        except Exception:
            log.exception("Failed to finalize session on disconnect")


async def workout_websocket(websocket: WebSocket, user_id: str) -> None:
    if not USER_ID_RE.match(user_id):
        await websocket.close(code=1008, reason="Invalid user id")
        return
    await websocket.accept()
    coach = CoachSession(websocket, user_id)
    try:
        while True:
            try:
                data = await websocket.receive_json()
            except ValueError:
                await coach.send({"type": "error", "message": "Messages must be JSON"})
                continue
            if not isinstance(data, dict):
                await coach.send({"type": "error", "message": "Messages must be JSON objects"})
                continue
            await coach.handle(data)
    except WebSocketDisconnect:
        pass
    finally:
        # Shield so the session is still saved if this handler is being cancelled (e.g. shutdown).
        await asyncio.shield(coach.close())
