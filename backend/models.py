"""Pydantic schemas for the REST API and WebSocket protocol."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

JointStatus = Literal["good", "warn", "bad"]


# ---- WebSocket: client → server -------------------------------------------------

class StartMessage(BaseModel):
    type: Literal["start"]
    exercise_id: str


class Measurement(BaseModel):
    """What the pose engine measured for a fault: the metric reading against the rule's thresholds."""

    metric: str = Field(max_length=64)
    value: float
    op: Literal["<", ">"]
    warn: float
    bad: float | None = None


class IssueMessage(BaseModel):
    """A form fault the browser detected (it scores every frame locally)."""

    type: Literal["issue"]
    fault_id: str = Field(max_length=64)
    status: Literal["warn", "bad"]
    side: Literal["left", "right"] | None = None
    from_rep: bool = False
    measurement: Measurement | None = None
    # ST-GCN probability that this fault happened on the last rep, when the form model is loaded.
    model_prob: float | None = Field(default=None, ge=0, le=1)


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


class SessionSummary(BaseModel):
    session_id: str
    text: str
    source: Literal["llm", "template"]


class IssueCount(BaseModel):
    fault_id: str
    label: str
    count: int


class UserStats(BaseModel):
    user_id: str
    total_sessions: int
    total_reps: int
    total_hold_sec: int
    total_duration_sec: float
    avg_score: float | None
    by_exercise: dict[str, int]
    common_issues: list[IssueCount]
