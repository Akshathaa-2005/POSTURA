from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from database import WorkoutSession, get_db
from models import SessionOut, SessionSummary
from services import user_service
from services.correction_generator import generate_summary
from services.exercises import get_exercise

router = APIRouter(prefix="/api", tags=["workouts"])


@router.get("/users/{user_id}/sessions", response_model=list[SessionOut])
async def user_sessions(user_id: str, limit: int = Query(50, ge=1, le=500), db: AsyncSession = Depends(get_db)):
    return await user_service.list_sessions(db, user_id, limit)


@router.get("/sessions/{session_id}", response_model=SessionOut)
async def session_detail(session_id: str, db: AsyncSession = Depends(get_db)):
    session = await db.get(WorkoutSession, session_id)
    if session is None:
        raise HTTPException(404, "Session not found")
    return session


# Debriefs are cached per session: the LLM runs once, however often the page is opened.
_summaries: dict[str, SessionSummary] = {}


@router.get("/sessions/{session_id}/summary", response_model=SessionSummary)
async def session_summary(session_id: str, db: AsyncSession = Depends(get_db)):
    if session_id in _summaries:
        return _summaries[session_id]
    session = await db.get(WorkoutSession, session_id)
    if session is None:
        raise HTTPException(404, "Session not found")
    if session.ended_at is None:
        raise HTTPException(409, "Session is still in progress")
    exercise = get_exercise(session.exercise_id)
    digest = await user_service.session_digest(db, session_id)
    if exercise is None or digest is None:
        raise HTTPException(404, "Session not found")
    text, source = await generate_summary(exercise, digest)
    _summaries[session_id] = out = SessionSummary(session_id=session_id, text=text, source=source)
    return out
