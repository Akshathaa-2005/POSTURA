"""Pydantic schemas for the REST API and WebSocket protocol."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

JointStatus = Literal["good", "warn", "bad"]


# ---- WebSocket: client → server -------------------------------------------------

class StartMessage(BaseModel):
    type: Literal["start"]
    exercise_id: str


class IssueMessage(BaseModel):
    """A form fault the browser detected (it scores every frame locally)."""

    type: Literal["issue"]
    fault_id: str = Field(max_length=64)
    status: Literal["warn", "bad"]
    side: Literal["left", "right"] | None = None
    from_rep: bool = False


class PraiseMessage(BaseModel):
    type: Literal["praise"]


class RepMessage(BaseModel):
    type: Literal["rep"]
    event: Literal["rep", "partial"]
    reps: int = Field(ge=0)
    rom: float


class EndMessage(BaseModel):
    type: Literal["end"]
    reps: int = Field(ge=0)
    avg_score: float | None = None
    duration_sec: float = Field(ge=0)


# ---- REST ---------------------------------------------------------------------

class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    exercise_id: str
    started_at: datetime
    ended_at: datetime | None
    rep_target: int
    reps: int
    partial_reps: int
    avg_score: float | None
    duration_sec: float


class IssueCount(BaseModel):
    fault_id: str
    label: str
    count: int


class UserStats(BaseModel):
    user_id: str
    total_sessions: int
    total_reps: int
    total_duration_sec: float
    avg_score: float | None
    by_exercise: dict[str, int]
    common_issues: list[IssueCount]
