from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from database import WorkoutSession, get_db
from models import SessionOut
from services import user_service

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
