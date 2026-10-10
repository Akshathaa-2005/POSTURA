from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BASE_DIR / ".env", extra="ignore")

    environment: str = "development"
    # SQLite works out of the box; set postgresql+asyncpg://… for Postgres.
    database_url: str = f"sqlite+aiosqlite:///{BASE_DIR / 'ai_coach.db'}"
    cors_origins: str = "http://localhost:3000"

    exercises_path: Path = BASE_DIR.parent / "exercises" / "exercises.json"

    ollama_api_url: str = "http://localhost:11434"
    ollama_model: str = "mistral"
    llm_timeout_sec: float = 25.0

    tts_enabled: bool = True
    tts_rate: int = 175
    audio_dir: Path = BASE_DIR / "static" / "audio"
    audio_max_age_sec: int = 6 * 3600

    # Coaching cadence (the browser already debounces faults; this paces the voice)
    correction_cooldown_sec: float = 6.0  # minimum gap between any two spoken cues
    same_issue_cooldown_sec: float = 15.0  # before repeating the same correction
    praise_cooldown_sec: float = 20.0  # minimum gap between spoken encouragements

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
