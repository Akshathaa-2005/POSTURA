import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from config import get_settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    sessions: Mapped[list["WorkoutSession"]] = relationship(back_populates="user")


class WorkoutSession(Base):
    __tablename__ = "workout_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    exercise_id: Mapped[str] = mapped_column(String(64), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rep_target: Mapped[int] = mapped_column(Integer, default=0)
    reps: Mapped[int] = mapped_column(Integer, default=0)
    partial_reps: Mapped[int] = mapped_column(Integer, default=0)
    avg_score: Mapped[float | None] = mapped_column(Float)
    duration_sec: Mapped[float] = mapped_column(Float, default=0)

    user: Mapped[User] = relationship(back_populates="sessions")
    cues: Mapped[list["CoachingCue"]] = relationship(back_populates="session", cascade="all, delete-orphan")


class CoachingCue(Base):
    """Every cue the coach delivered, for progress analytics."""

    __tablename__ = "coaching_cues"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("workout_sessions.id"), index=True)
    fault_id: Mapped[str] = mapped_column(String(64), index=True)
    label: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(8))
    side: Mapped[str | None] = mapped_column(String(8))
    from_rep: Mapped[bool] = mapped_column(Boolean, default=False)
    cue: Mapped[str] = mapped_column(Text)
    correction: Mapped[str] = mapped_column(Text)
    correction_source: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    session: Mapped[WorkoutSession] = relationship(back_populates="cues")


engine = create_async_engine(get_settings().database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def init_db() -> None:
    # Phase 2 uses create_all; switch to Alembic migrations once the schema stabilises.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_db():
    async with SessionLocal() as session:
        yield session


__all__ = ["AsyncSession", "Base", "CoachingCue", "SessionLocal", "User", "WorkoutSession", "get_db", "init_db"]
