import os
import tempfile

# Configure before the app (and its DB engine) is imported.
_tmp = tempfile.mkdtemp(prefix="ai_coach_test_")
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_tmp}/test.db"
os.environ["OLLAMA_API_URL"] = "http://127.0.0.1:9"  # nothing listens here → template fallback
os.environ["TTS_ENABLED"] = "false"
os.environ["AUDIO_DIR"] = f"{_tmp}/audio"
