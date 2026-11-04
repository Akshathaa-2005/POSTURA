"""Structured-JSON calls to a free hosted LLM API (OpenAI-compatible chat endpoint), with validation-driven retries.

Default provider is Groq's free tier; any OpenAI-compatible endpoint works via PLAN_API_URL / PLAN_MODEL.
Failures are split in two so the API can answer correctly:
LLMUnavailable (no key / network / rate limit / timeout → 503) and LLMBadOutput (model kept returning
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

# Free tiers reset per minute; wait and retry a rate-limited call instead of failing the whole plan.
RATE_LIMIT_WAITS_SEC = (15, 30)


class LLMError(Exception):
    pass


class LLMUnavailable(LLMError):
    pass


class LLMBadOutput(LLMError):
    pass


def model_name() -> str:
    return get_settings().plan_model


async def _chat(messages: list[dict[str, str]], schema: dict | None, max_tokens: int) -> str:
    s = get_settings()
    if not s.plan_api_key:
        raise LLMUnavailable("No plan API key is set. Add PLAN_API_KEY to backend/.env (free key at console.groq.com).")
    if schema:
        # JSON mode guarantees valid JSON, not the shape; spell the shape out and let the parser enforce it.
        messages = [{"role": "system", "content": f"Respond with JSON matching this JSON Schema:\n{json.dumps(schema)}"}, *messages]
    body = {
        "model": model_name(),
        "messages": messages,
        "response_format": {"type": "json_object"},
        # Reasoning models otherwise spend the whole token budget thinking and return no JSON.
        "reasoning_effort": "low",
        "temperature": 0.3,
        "max_tokens": max_tokens,
    }
    headers = {"Authorization": f"Bearer {s.plan_api_key}"}
    try:
        async with httpx.AsyncClient(timeout=s.plan_llm_timeout_sec) as client:
            for wait in (*RATE_LIMIT_WAITS_SEC, None):
                r = await client.post(f"{s.plan_api_url.rstrip('/')}/chat/completions", json=body, headers=headers)
                if r.status_code != 429 or wait is None:
                    break
                log.info("plan API rate limited; waiting %ss before retrying", wait)
                await asyncio.sleep(wait)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]
    except httpx.TimeoutException as exc:
        raise LLMUnavailable("The AI service took too long to answer. Try again.") from exc
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        if code in (401, 403):
            raise LLMUnavailable("The plan API key was rejected. Check PLAN_API_KEY in backend/.env.") from exc
        if code == 429:
            raise LLMUnavailable("The free AI service rate limit was hit. Wait a minute and try again.") from exc
        if code == 404:
            raise LLMUnavailable(f"Model '{model_name()}' was not found at the plan API. Check PLAN_MODEL.") from exc
        raise LLMUnavailable(f"The plan API returned HTTP {code}.") from exc
    except httpx.HTTPError as exc:
        raise LLMUnavailable("Can't reach the plan API. Check the network connection.") from exc
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise LLMBadOutput("The plan API sent an unexpected response.") from exc


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
