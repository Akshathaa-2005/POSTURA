import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from config import get_settings
from database import engine, init_db
from routes import analytics, exercises, workouts
from services.correction_generator import ollama_available
from services.tts_service import cleanup_old_audio, tts_available
from websocket_handler import workout_websocket

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
settings = get_settings()
settings.audio_dir.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    cleanup_old_audio()
    yield
    await engine.dispose()


app = FastAPI(title="AI Coach API", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(exercises.router)
app.include_router(workouts.router)
app.include_router(analytics.router)
app.mount("/audio", StaticFiles(directory=settings.audio_dir), name="audio")


@app.get("/api/health")
async def health():
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False
    return {
        "status": "ok" if db_ok else "degraded",
        "database": {"ok": db_ok, "backend": engine.dialect.name},
        "llm": {"available": await ollama_available(), "model": settings.ollama_model},
        "tts": {"available": tts_available()},
    }


@app.websocket("/ws/workout/{user_id}")
async def workout_ws(websocket: WebSocket, user_id: str):
    await workout_websocket(websocket, user_id)
