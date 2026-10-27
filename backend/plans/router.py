import json

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from services.user_service import get_or_create_user

from . import llm_service, service
from .models import PlanRecord
from .schemas import GenerateRequest, GenerateResponse, PlanBody, PlanSummary, Profile, StoredPlan

router = APIRouter(prefix="/api", tags=["plans"])
UserId = Path(pattern=r"^[A-Za-z0-9_-]{1,64}$")


def _stored(rec: PlanRecord) -> StoredPlan:
    return StoredPlan(
        id=rec.id, user_id=rec.user_id, created_at=rec.created_at, model=rec.model,
        profile=Profile.model_validate(rec.profile), plan=PlanBody.model_validate(rec.plan),
    )


async def _owned(db: AsyncSession, plan_id: str, user_id: str) -> PlanRecord:
    rec = await db.get(PlanRecord, plan_id)
    if rec is None or rec.user_id != user_id:  # 404 either way, so ids can't be probed
        raise HTTPException(404, "Plan not found")
    return rec


@router.post("/users/{user_id}/plans/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest, user_id: str = UserId, db: AsyncSession = Depends(get_db)):
    try:
        out = await service.generate_plan(req.profile, req.free_text, req.adjustment)
    except llm_service.LLMUnavailable as exc:
        return JSONResponse({"detail": str(exc), "code": "llm_unavailable"}, status_code=503)
    except llm_service.LLMBadOutput as exc:
        return JSONResponse({"detail": str(exc), "code": "llm_bad_output"}, status_code=502)

    if out.status != "ok" or out.plan is None or out.profile is None:
        return GenerateResponse(status=out.status, questions=out.questions, profile=out.profile, safety=out.safety)

    await get_or_create_user(db, user_id)
    rec = PlanRecord(
        user_id=user_id, model=llm_service.model_name(), title=out.plan.title[:120], goal=out.profile.goal,
        profile=out.profile.model_dump(), plan=out.plan.model_dump(),
    )
    db.add(rec)
    await db.commit()
    return GenerateResponse(status="ok", plan=_stored(rec), profile=out.profile, safety=out.safety)


@router.get("/users/{user_id}/plans", response_model=list[PlanSummary])
async def list_plans(user_id: str = UserId, limit: int = Query(20, ge=1, le=100), db: AsyncSession = Depends(get_db)):
    rows = await db.scalars(select(PlanRecord).where(PlanRecord.user_id == user_id).order_by(PlanRecord.created_at.desc()).limit(limit))
    return [PlanSummary(id=r.id, title=r.title, created_at=r.created_at, goal=r.goal) for r in rows]


@router.get("/users/{user_id}/plans/{plan_id}", response_model=StoredPlan)
async def get_plan(plan_id: str, user_id: str = UserId, db: AsyncSession = Depends(get_db)):
    return _stored(await _owned(db, plan_id, user_id))


@router.get("/users/{user_id}/plans/{plan_id}/export")
async def export_plan(plan_id: str, fmt: str = Query("json", pattern="^(json|md)$"), user_id: str = UserId, db: AsyncSession = Depends(get_db)):
    stored = _stored(await _owned(db, plan_id, user_id))
    if fmt == "md":
        return PlainTextResponse(service.to_markdown(stored.plan), headers={"Content-Disposition": f'attachment; filename="plan-{plan_id}.md"'})
    return JSONResponse(json.loads(stored.model_dump_json()), headers={"Content-Disposition": f'attachment; filename="plan-{plan_id}.json"'})


@router.delete("/users/{user_id}/plans/{plan_id}", status_code=204)
async def delete_plan(plan_id: str, user_id: str = UserId, db: AsyncSession = Depends(get_db)):
    await db.delete(await _owned(db, plan_id, user_id))
    await db.commit()
