from typing import Any

from fastapi import APIRouter, HTTPException

from services.exercises import get_exercise, load_exercises

router = APIRouter(prefix="/api/exercises", tags=["exercises"])


@router.get("")
async def list_exercises() -> list[dict[str, Any]]:
    return list(load_exercises().values())


@router.get("/{exercise_id}")
async def exercise_detail(exercise_id: str) -> dict[str, Any]:
    exercise = get_exercise(exercise_id)
    if exercise is None:
        raise HTTPException(404, f"Unknown exercise: {exercise_id}")
    return exercise
