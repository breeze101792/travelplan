"""AI core — shared by the web chat endpoint and the MCP server.

This module is deliberately dependency-free (stdlib only) so both the Flask
app and the standalone MCP server can import it. It reads the LLM connection
details from ``data/config/ai.json`` and calls any OpenAI-compatible
``/chat/completions`` endpoint (OpenAI, a local Ollama, a gateway, etc.).

Config file ``data/config/ai.json`` (gitignored, mirrors ``secret_key``):

    {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-...",
      "model": "gpt-4o-mini",
      "searxng_url": "http://localhost:8888"
    }

``searxng_url`` is optional: when set, the chat agent can search the web via
a SearXNG instance (``/search?q=...&format=json``). If the file is missing or
empty, :func:`extract_item` / :func:`chat` raise :class:`AIConfigError` so
callers can report "AI not configured".
"""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

from .blueprints.items import _coerce_when, ITEM_TYPES

CONFIG_PATH = Path(__file__).resolve().parent.parent / "data" / "config" / "ai.json"

# Timeout for the upstream LLM call (seconds). A single round-trip; a generous
# timeout avoids hanging the caller on a slow model.
_HTTP_TIMEOUT = 60

# Retries when the model returns an empty / non-JSON reply (intermittent with
# image input). Each attempt is a fresh HTTP request.
_MAX_RETRIES = 3

# Max web-search rounds in a single chat turn (each round is one LLM call plus
# one SearXNG query). Bounded so a model that keeps asking to search cannot
# loop forever.
_MAX_SEARCH_ROUNDS = 3


class AIConfigError(Exception):
    """Raised when the AI config is missing or incomplete."""


def load_ai_config() -> dict:
    """Return the parsed ``ai.json`` config, or raise :class:`AIConfigError`.

    The config is re-read on every call so edits to the file take effect
    without a restart (the MCP server and web app both call this per request).
    """
    if not CONFIG_PATH.exists():
        raise AIConfigError("AI is not configured: data/config/ai.json is missing")
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise AIConfigError(f"AI config is invalid: {e}")
    if not isinstance(cfg, dict):
        raise AIConfigError("AI config must be a JSON object")
    base_url = (cfg.get("base_url") or "").strip().rstrip("/")
    api_key = (cfg.get("api_key") or "").strip()
    model = (cfg.get("model") or "").strip()
    if not base_url or not model:
        raise AIConfigError("AI config must set base_url and model")
    searxng_url = (cfg.get("searxng_url") or "").strip().rstrip("/")
    return {"base_url": base_url, "api_key": api_key, "model": model,
            "searxng_url": searxng_url or None}


def read_ai_config() -> dict:
    """Return the raw config dict (or an empty dict if missing/invalid).

    Used by the admin settings page to pre-fill the form. Never raises.
    """
    if not CONFIG_PATH.exists():
        return {}
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(cfg, dict):
        return {}
    return cfg


def write_ai_config(cfg: dict) -> None:
    """Persist the config dict to ``ai.json`` (creating the config dir)."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    try:
        CONFIG_PATH.chmod(0o600)
    except OSError:
        pass


def _parse_json_content(content: str) -> dict:
    """Robustly parse the model's reply into a JSON object.

    Models sometimes wrap JSON in markdown fences (```json ... ```) or preface
    it with prose. We try strict parsing first, then strip common noise and
    extract the first balanced ``{ ... }`` object.
    """
    if isinstance(content, str):
        s = content.strip()
    else:
        s = str(content).strip()

    # Markdown fenced code block.
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", s)
    if fenced:
        s = fenced.group(1).strip()

    try:
        return json.loads(s)
    except (json.JSONDecodeError, ValueError):
        pass

    # Fall back to the first balanced JSON object.
    start = s.find("{")
    if start >= 0:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(s)):
            ch = s[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(s[start:i + 1])
                    except (json.JSONDecodeError, ValueError):
                        break
    raise ValueError("no JSON object found in AI reply")


def _call_chat_completions(cfg: dict, messages: list[dict], json_mode: bool = True) -> dict:
    """Call the OpenAI-compatible chat completions endpoint.

    ``messages`` is the full message list (system + turns). Returns the parsed
    JSON object from the model's reply. Raises on transport/HTTP errors.

    Hardened against flaky model output: empty / non-JSON / markdown-wrapped
    replies are retried (up to ``_MAX_RETRIES``) and, if still failing, raise a
    clear :class:`ValueError` — never a raw ``json.JSONDecodeError`` or an
    ``IndexError``/``KeyError``.
    """
    url = f"{cfg['base_url']}/chat/completions"
    # Some gateways expose the OpenAI-compatible route under /v1 and some
    # don't. If the configured base_url already ends in /v1, keep it;
    # otherwise insert /v1 so both "http://host:port" and
    # "http://host:port/v1" work.
    if not cfg["base_url"].endswith("/v1"):
        url = f"{cfg['base_url']}/v1/chat/completions"
    payload = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": 0,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    last_err = None
    for _attempt in range(_MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
                raw_body = resp.read().decode("utf-8", errors="replace")
            body = json.loads(raw_body)
            content = body["choices"][0]["message"]["content"]
            if not content or not str(content).strip():
                last_err = "AI returned an empty response"
                continue
            return _parse_json_content(content)
        except (json.JSONDecodeError, ValueError, KeyError, IndexError, TypeError) as e:
            last_err = f"AI returned a non-JSON response: {e}"
            continue
    raise ValueError(last_err or "AI request failed")


def web_search(query: str, searxng_url: str | None = None, max_results: int = 5) -> list[dict]:
    """Search the web via a SearXNG instance and return the top hits.

    ``searxng_url`` is the base URL of a SearXNG instance (e.g.
    ``http://localhost:8888``). If omitted it is read from the AI config.
    Returns a list of ``{title, url, content}`` dicts (content is the snippet).
    Raises :class:`AIConfigError` if no SearXNG URL is configured, and
    ``ValueError`` on a transport/parse error.
    """
    if not searxng_url:
        searxng_url = load_ai_config().get("searxng_url")
    if not searxng_url:
        raise AIConfigError("web search is not configured: set searxng_url in data/config/ai.json")
    url = f"{searxng_url}/search?q={urllib.parse.quote(query)}&format=json"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace"))
    except (OSError, ValueError) as e:
        raise ValueError(f"web search failed: {e}")
    results = body.get("results") or []
    out = []
    for r in results[:max_results]:
        title = (r.get("title") or "").strip()
        link = (r.get("url") or "").strip()
        content = (r.get("content") or "").strip()
        if title or link:
            out.append({"title": title, "url": link, "content": content})
    return out


def test_connections(cfg: dict | None = None) -> dict:
    """Verify the AI provider and SearXNG endpoints are reachable.

    ``cfg`` is an optional config dict (as returned by :func:`load_ai_config`).
    If omitted it is loaded from disk. Returns a dict with one entry per
    service: ``{"ai": {"ok": bool, "detail": str}, "searxng": {...}}``. Never
    raises; each service reports its own status.
    """
    if cfg is None:
        try:
            cfg = load_ai_config()
        except AIConfigError as e:
            cfg = {"error": str(e)}
    result: dict = {}

    # ---- AI provider: hit the OpenAI-compatible /models endpoint ----
    base_url = (cfg.get("base_url") or "").strip().rstrip("/")
    model = (cfg.get("model") or "").strip()
    if not base_url or not model:
        result["ai"] = {"ok": False, "detail": "base_url and model are required"}
    else:
        url = f"{base_url}/models"
        headers = {}
        if cfg.get("api_key"):
            headers["Authorization"] = f"Bearer {cfg['api_key']}"
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
                body = json.loads(resp.read().decode("utf-8", errors="replace"))
            models = [m.get("id") for m in (body.get("data") or []) if isinstance(m, dict)]
            if model in models:
                result["ai"] = {"ok": True, "detail": f"model '{model}' available"}
            elif models:
                avail = ", ".join(str(m) for m in models[:5])
                result["ai"] = {"ok": False,
                                "detail": f"model '{model}' not found (available: {avail})"}
            else:
                result["ai"] = {"ok": True, "detail": "endpoint reachable (no model list returned)"}
        except (OSError, ValueError) as e:
            result["ai"] = {"ok": False, "detail": f"connection failed: {e}"}

    # ---- SearXNG: run a trivial search ----
    searxng_url = (cfg.get("searxng_url") or "").strip().rstrip("/")
    if not searxng_url:
        result["searxng"] = {"ok": False, "detail": "searxng_url not configured"}
    else:
        try:
            hits = web_search("test", searxng_url=searxng_url, max_results=1)
            result["searxng"] = {"ok": True,
                                 "detail": f"reachable ({len(hits)} result(s) for 'test')"}
        except (AIConfigError, ValueError) as e:
            result["searxng"] = {"ok": False, "detail": str(e)}

    return result


def _item_type_schema(settings: dict) -> str:
    """Render the item-type field schema as a prompt fragment."""
    types = settings.get("item_types") or {}
    lines = []
    for t, spec in types.items():
        fields = spec.get("fields") or []
        labels = ", ".join(f"{f.get('key')} ({f.get('label')})" for f in fields)
        lines.append(f"- {t}: {labels or '(no fields)'}")
    return "\n".join(lines)


def _build_extract_prompt(settings: dict, item_type: str | None = None) -> str:
    """System prompt for the single-item extraction flow."""
    types = settings.get("item_types") or {}
    lines = [
        "You extract structured travel itinerary items from raw text "
        "(flight tickets, hotel confirmations, restaurant bookings, notes).",
        "Respond with a single JSON object only, no prose.",
        "The object may contain:",
        '  "item_type": one of ' + ", ".join(sorted(types.keys())) + ".",
        '  "title": a short human-readable title.',
        '  "details": an object of field values for that item type.',
        '  "when": {"start_at": "YYYY-MM-DDTHH:MM", "end_at": "YYYY-MM-DDTHH:MM"} '
        "if a date/time is present (end_at optional).",
        "",
        "Allowed item types and their fields:",
        _item_type_schema(settings),
        "Only include fields that are present in the text. "
        "If the text is not travel-related, set item_type to 'note' and put "
        "the raw text in details.text.",
    ]
    if item_type:
        lines.append(f"\nThe user wants a '{item_type}' item; use that item_type.")
    return "\n".join(lines)


def _build_chat_prompt(settings: dict, plan_context: str, can_search: bool = False) -> str:
    """System prompt for the conversational chat flow."""
    types = settings.get("item_types") or {}
    lines = [
        "You are a helpful travel-planning assistant embedded in a trip-planning app.",
        "You help the user plan their trip: answer questions, and when the user "
        "pastes a ticket/confirmation or asks you to add something, suggest "
        "structured itinerary items they can add.",
        "You have access to the current plan's context below.",
        "",
        "Plan context:",
        plan_context,
        "",
        "Respond with a single JSON object:",
        '  "reply": a friendly, concise answer to the user.',
        '  "items": an array of suggested itinerary items to add. Each item:',
        '    {"item_type": one of ' + ", ".join(sorted(types.keys())) + ", "
        '"title": "...", "details": {...}, "when": {"start_at": "...", "end_at": "..."}}',
        "  Use an empty array [] if no items are suggested.",
        "",
        "Allowed item types and their fields:",
        _item_type_schema(settings),
    ]
    if can_search:
        lines += [
            "",
            "You can search the web for up-to-date information. When the user asks "
            "about something that may have changed recently (weather, opening hours, "
            "prices, events, transport status, etc.), or when you are unsure, set:",
            '  "search": "a concise search query"',
            "  and leave \"reply\" and \"items\" empty. The search results will be "
            "provided to you, and you will then answer with a final reply.",
        ]
    return "\n".join(lines)


def _normalize_item(raw: dict) -> dict:
    """Validate and normalize a suggested item into the editor's snapshot shape."""
    it_type = raw.get("item_type")
    if it_type not in ITEM_TYPES:
        raise ValueError(f"AI returned invalid item_type: {it_type!r}")
    details = raw.get("details") or {}
    if not isinstance(details, dict):
        details = {}
    when = _coerce_when(details.get("when") if isinstance(details.get("when"), dict) else raw.get("when"))
    if when:
        details["when"] = when
    else:
        details.pop("when", None)
    item_date = raw.get("item_date")
    end_date = raw.get("end_date")
    if when.get("start_at"):
        item_date = when["start_at"][:10]
    if when.get("end_at"):
        end_date = when["end_at"][:10]
    return {
        "item_type": it_type,
        "title": (raw.get("title") or "").strip() or "(Untitled)",
        "details": details,
        "when": when,
        "item_date": item_date,
        "end_date": end_date,
    }


def extract_item(text: str, item_type: str | None = None, settings: dict | None = None) -> dict:
    """Extract a structured itinerary item from raw ``text``.

    ``settings`` is the parsed ``settings.json`` (item-type schemas). If
    omitted it is loaded from disk. ``item_type`` optionally constrains the
    model to a single type.

    Returns a dict shaped like the item editor's snapshot:
    ``{item_type, title, details, when, item_date, end_date}``.

    Raises :class:`AIConfigError` if the AI is not configured, and
    ``ValueError`` if the model returns an invalid item_type.
    """
    if settings is None:
        settings = _load_settings()
    cfg = load_ai_config()
    prompt = _build_extract_prompt(settings, item_type)
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": [{"type": "text", "text": text}]},
    ]
    raw = _call_chat_completions(cfg, messages)
    if not isinstance(raw, dict):
        raise ValueError("AI returned a non-object response")
    if not raw.get("item_type"):
        raw["item_type"] = item_type
    return _normalize_item(raw)


def chat(plan_context: str, messages: list[dict], image_url: str | None = None,
         settings: dict | None = None) -> dict:
    """Run a conversational turn against the plan's AI assistant.

    ``plan_context`` is a short text summary of the plan (title, dates, items).
    ``messages`` is the conversation history as ``[{role, content}]`` (the last
    entry is the user's current message). ``image_url`` optionally attaches an
    image (a full data URL) to the last user message.

    Returns ``{"reply": str, "items": [normalized item, ...]}``. ``items`` are
    suggested itinerary items the client can offer to add.

    Raises :class:`AIConfigError` if the AI is not configured, and
    ``ValueError`` if the model returns an invalid item_type.
    """
    if settings is None:
        settings = _load_settings()
    cfg = load_ai_config()
    can_search = bool(cfg.get("searxng_url"))
    system = _build_chat_prompt(settings, plan_context, can_search=can_search)
    llm_messages: list[dict] = [{"role": "system", "content": system}]
    last_idx = len(messages) - 1
    for i, m in enumerate(messages):
        role = m.get("role")
        content = m.get("content") or ""
        if role == "user":
            parts: list[dict] = [{"type": "text", "text": content}]
            if image_url and i == last_idx:
                parts.append({"type": "image_url", "image_url": {"url": image_url}})
            llm_messages.append({"role": "user", "content": parts})
        else:
            llm_messages.append({"role": "assistant", "content": content})

    # Tool-calling loop: the model may request a web search; we run it and
    # feed the results back, then let the model produce the final answer.
    raw: dict = {}
    for _ in range(_MAX_SEARCH_ROUNDS):
        raw = _call_chat_completions(cfg, llm_messages)
        if not isinstance(raw, dict):
            raise ValueError("AI returned a non-object response")
        query = raw.get("search")
        if not query or not can_search:
            break
        results = web_search(str(query), searxng_url=cfg.get("searxng_url"))
        if not results:
            llm_messages.append({
                "role": "system",
                "content": "Web search returned no results. Answer from your own knowledge.",
            })
        else:
            lines = ["Web search results for the query above:"]
            for i, r in enumerate(results, 1):
                lines.append(f"{i}. {r['title']} — {r['url']}\n   {r['content']}")
            llm_messages.append({"role": "system", "content": "\n".join(lines)})

    reply = raw.get("reply") or ""
    items = []
    for it in raw.get("items") or []:
        if not isinstance(it, dict):
            continue
        try:
            items.append(_normalize_item(it))
        except ValueError:
            continue
    return {"reply": reply, "items": items}


def _load_settings() -> dict:
    """Load ``data/config/settings.json`` (item-type schemas)."""
    path = Path(__file__).resolve().parent.parent / "data" / "config" / "settings.json"
    return json.loads(path.read_text(encoding="utf-8"))
