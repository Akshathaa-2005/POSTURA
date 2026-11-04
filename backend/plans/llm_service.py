"""Structured-JSON calls to the local Ollama server, with validation-driven retries.

Only Ollama is used (no hosted APIs). Failures are split in two so the API can answer correctly:
LLMUnavailable (server down / model missing / timeout → 503) and LLMBadOutput (model kept returning
unusable JSON → 502).
"""

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any, TypeVar

import httpx
from pydantic import ValidationError

from config import get_settings

from .prompts import RETRY

log = logging.getLogger(__name__)
T = TypeVar("T")

# A local model serves one generation at a time; queue instead of timing everyone out.
_gate = asyncio.Semaphore(1)


class LLMError(Exception):
    pass


class LLMUnavailable(LLMError):
    pass


class LLMBadOutput(LLMError):
    pass


def model_name() -> str:
    s = get_settings()
    return s.plan_model or s.ollama_model


async def _chat(messages: list[dict[str, str]], schema: dict | None, max_tokens: int) -> str:
    s = get_settings()
    body = {
        "model": model_name(),
        "messages": messages,
        "stream": False,
        "format": schema or "json",
        "options": {"temperature": 0.3, "num_predict": max_tokens, "num_ctx": 6144},
    }
    try:
        async with _gate, httpx.AsyncClient(timeout=s.plan_llm_timeout_sec) as client:
            r = await client.post(f"{s.ollama_api_url}/api/chat", json=body)
            r.raise_for_status()
            return r.json()["message"]["content"]
    except httpx.TimeoutException as exc:
        raise LLMUnavailable("The local model took too long to answer. Try again, or use a smaller model.") from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            raise LLMUnavailable(f"Model '{model_name()}' is not installed in Ollama (run: ollama pull {model_name()}).") from exc
        raise LLMUnavailable(f"Ollama returned HTTP {exc.response.status_code}.") from exc
    except httpx.HTTPError as exc:
        raise LLMUnavailable("Can't reach the local Ollama server. Is it running?") from exc
    except (KeyError, ValueError) as exc:
        raise LLMBadOutput("Ollama sent an unexpected response.") from exc


async def generate(
    system: str,
    user: str,
    parse: Callable[[Any], T],
    *,
    schema: dict | None = None,
    max_tokens: int = 3000,
) -> T:
    """Ask for JSON, run `parse` (which may raise ValueError/ValidationError to reject it), and retry with the
    rejection reason fed back to the model."""
    attempts = max(1, get_settings().plan_llm_attempts)
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    last = "unknown"
    for attempt in range(attempts):
        text = await _chat(messages, schema, max_tokens)
        try:
            return parse(json.loads(text))
        except (ValueError, ValidationError) as exc:  # JSONDecodeError and pydantic errors are ValueErrors
            last = _short(exc)
            log.info("plan LLM output rejected (attempt %d/%d): %s | reply: %.300s", attempt + 1, attempts, last, text)
            messages += [{"role": "assistant", "content": text}, {"role": "user", "content": RETRY.format(error=last)}]
    raise LLMBadOutput(f"The model could not produce a valid result ({last}). Please try again.")


def _short(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()[:6])
    return str(exc)[:300]
