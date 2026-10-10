from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import UserStats
from services import user_service

router = APIRouter(prefix="/api/users", tags=["analytics"])


@router.get("/{user_id}/stats", response_model=UserStats)
async def stats(user_id: str, db: AsyncSession = Depends(get_db)):
    return await user_service.user_stats(db, user_id)
