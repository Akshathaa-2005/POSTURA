"""Database operations for users, workout sessions and logged form issues."""

from collections import Counter

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import CoachingCue, User, WorkoutSession, utcnow
from models import IssueCount, UserStats


async def get_or_create_user(db: AsyncSession, user_id: str) -> User:
    user = await db.get(User, user_id)
    if user is None:
        user = User(id=user_id)
        db.add(user)
        await db.commit()
    return user


async def start_session(db: AsyncSession, user_id: str, exercise_id: str, rep_target: int) -> WorkoutSession:
    await get_or_create_user(db, user_id)
    session = WorkoutSession(user_id=user_id, exercise_id=exercise_id, rep_target=rep_target)
    db.add(session)
    await db.commit()
    return session


async def record_partial_rep(db: AsyncSession, session_id: str) -> None:
    session = await db.get(WorkoutSession, session_id)
    if session:
        session.partial_reps += 1
        await db.commit()


async def update_reps(db: AsyncSession, session_id: str, reps: int) -> None:
    session = await db.get(WorkoutSession, session_id)
    if session:
        session.reps = reps
        await db.commit()


async def end_session(
    db: AsyncSession, session_id: str, reps: int, avg_score: float | None, duration_sec: float
) -> WorkoutSession | None:
    session = await db.get(WorkoutSession, session_id)
    if session is None:
        return None
    session.reps = reps
    session.avg_score = avg_score
    session.duration_sec = duration_sec
    session.ended_at = utcnow()
    await db.commit()
    return session


async def log_cue(
    db: AsyncSession,
    session_id: str,
    *,
    fault_id: str,
    label: str,
    status: str,
    side: str | None,
    from_rep: bool,
    cue: str,
    correction: str,
    source: str,
) -> None:
    db.add(
        CoachingCue(
            session_id=session_id,
            fault_id=fault_id,
            label=label,
            status=status,
            side=side,
            from_rep=from_rep,
            cue=cue,
            correction=correction,
            correction_source=source,
        )
    )
    await db.commit()


async def list_sessions(db: AsyncSession, user_id: str, limit: int = 50) -> list[WorkoutSession]:
    result = await db.execute(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == user_id)
        .order_by(WorkoutSession.started_at.desc())
        .limit(limit)
    )
    return list(result.scalars())


async def user_stats(db: AsyncSession, user_id: str) -> UserStats:
    sessions = await list_sessions(db, user_id, limit=10_000)
    scored = [s.avg_score for s in sessions if s.avg_score is not None]

    issue_rows = await db.execute(
        select(CoachingCue.fault_id, func.max(CoachingCue.label), func.count())
        .join(WorkoutSession, CoachingCue.session_id == WorkoutSession.id)
        .where(WorkoutSession.user_id == user_id, CoachingCue.fault_id != "setup")
        .group_by(CoachingCue.fault_id)
        .order_by(func.count().desc())
        .limit(5)
    )

    return UserStats(
        user_id=user_id,
        total_sessions=len(sessions),
        total_reps=sum(s.reps for s in sessions),
        total_duration_sec=sum(s.duration_sec for s in sessions),
        avg_score=sum(scored) / len(scored) if scored else None,
        by_exercise=dict(Counter(s.exercise_id for s in sessions)),
        common_issues=[IssueCount(fault_id=f, label=lbl, count=c) for f, lbl, c in issue_rows.all()],
    )
