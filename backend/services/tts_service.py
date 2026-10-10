"""Converts correction text to browser-playable WAV files using pyttsx3 (local, free)."""

import asyncio
import hashlib
import logging
import shutil
import sys
import time
from pathlib import Path

from config import BASE_DIR, get_settings

log = logging.getLogger(__name__)

# One synthesis at a time: the OS speech engines don't like concurrent use.
_lock = asyncio.Lock()
SYNTH_TIMEOUT_SEC = 20


def _audio_name(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:16] + ".wav"


async def _run(*cmd: str, stdin: bytes | None = None) -> None:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=BASE_DIR,
        stdin=asyncio.subprocess.PIPE if stdin is not None else None,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, err = await asyncio.wait_for(proc.communicate(stdin), SYNTH_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"{cmd[0]} timed out")
    if proc.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {err.decode(errors='ignore')[-300:]}")


async def text_to_speech(text: str) -> str | None:
    """Returns the filename (served under /audio/) of the spoken text, or None if TTS is unavailable."""
    s = get_settings()
    if not s.tts_enabled or not text.strip():
        return None

    s.audio_dir.mkdir(parents=True, exist_ok=True)
    name = _audio_name(text)
    out = s.audio_dir / name
    if out.exists():  # identical corrections reuse their audio
        out.touch()
        return name

    async with _lock:
        try:
            if sys.platform == "darwin":
                # macOS writes AIFF regardless of extension; convert so Chrome/Firefox can play it.
                raw = out.with_suffix(".aiff")
                await _run(sys.executable, "-m", "services.tts_worker", str(raw), str(s.tts_rate), stdin=text.encode())
                await _run("afconvert", "-f", "WAVE", "-d", "LEI16", str(raw), str(out))
                raw.unlink(missing_ok=True)
            else:
                await _run(sys.executable, "-m", "services.tts_worker", str(out), str(s.tts_rate), stdin=text.encode())
        except (RuntimeError, OSError) as exc:
            log.warning("TTS failed: %s", exc)
            return None

    return name if out.exists() and out.stat().st_size > 0 else None


def tts_available() -> bool:
    if not get_settings().tts_enabled:
        return False
    try:
        import pyttsx3  # noqa: F401
    except ImportError:
        return False
    return sys.platform != "darwin" or shutil.which("afconvert") is not None


def cleanup_old_audio() -> int:
    s = get_settings()
    cutoff = time.time() - s.audio_max_age_sec
    removed = 0
    for f in Path(s.audio_dir).glob("*.wav"):
        if f.stat().st_mtime < cutoff:
            f.unlink(missing_ok=True)
            removed += 1
    return removed
