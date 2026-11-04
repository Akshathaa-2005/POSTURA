"""Plan storage. Imported by router.py so the table exists before init_db() runs create_all."""

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from database import Base, new_id, utcnow


class PlanRecord(Base):
    """One generated plan. Immutable: regenerating/adjusting creates a new row, so history is kept."""

    __tablename__ = "plans"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    model: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(120))
    goal: Mapped[str | None] = mapped_column(String(32))
    profile: Mapped[dict] = mapped_column(JSON)  # normalised metric Profile used for generation
    plan: Mapped[dict] = mapped_column(JSON)  # PlanBody
