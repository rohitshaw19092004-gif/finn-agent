"""HTTP API for live Pull. Stateless apart from a disk cache; holds no personal data.

GET  /api/health
GET  /api/search?q=navin            -> [{name, symbol}]
GET  /api/research/{symbol}         -> dossier (cached 12h)
GET  /api/research/{symbol}/stream  -> Server-Sent Events: progress steps, then the dossier
GET  /api/ask?symbol=TMPV&q=...     -> grounded answer: the model may only use this company's own
                                       facts (numbers, verified call quotes, checked promises) and must cite them
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time

import re
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from . import http, llm
from .config import CACHE, settings
from .intel import research
from .sources import screener

app = FastAPI(title="FINN research API", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])
DOSSIERS = CACHE / "dossiers"
DOSSIERS.mkdir(parents=True, exist_ok=True)
TTL = 12 * 3600


def _cached(sym: str) -> dict | None:
    p = DOSSIERS / f"{sym}.json"
    if p.exists() and time.time() - p.stat().st_mtime < TTL:
        return json.loads(p.read_text(encoding="utf-8"))
    return None


def _store(sym: str, d: dict) -> None:
    # Only finished dossiers are cached; partial/failed/deferred ones are returned but retried next time.
    st = (d.get("analysis") or {}).get("status")
    if st not in ("complete", "unavailable", "numbers_only") and not (st == "seeded" and not llm.available()):
        return
    tmp = DOSSIERS / f".{sym}.{threading.get_ident()}.tmp"
    tmp.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, DOSSIERS / f"{sym}.json")   # atomic: a concurrent reader never sees half a file


@app.get("/")
def root():
    return {"service": "FINN API", "app": "https://rohitshaw19092004-gif.github.io/finn-agent/",
            "endpoints": ["/api/health", "/api/search?q=", "/api/research/{symbol}", "/api/ask?symbol=&q="]}


@app.get("/api/health")
def health():
    return {"ok": True, "llm": llm.available(),
            "models": {t: settings.models.chain(t) for t in ("bulk", "extract", "reason")}, "usage": llm.usage_report()}


@app.get("/api/search")
def search(q: str):
    if len(q) < 2:
        return []
    return screener.search(q)[:8]


@app.get("/api/research/{symbol}")
def get_research(symbol: str):
    try:
        sym = research.safe_symbol(symbol)
    except ValueError:
        raise HTTPException(400, "bad symbol")
    d = _cached(sym)
    if d is None:
        try:
            llm.start_run()          # each on-demand dossier gets its own model budget and fresh breakers
            d = research.build(sym)
        except Exception as e:
            raise HTTPException(404, f"could not build {sym}: {e}")
        _store(sym, d)
    return d


@app.get("/api/research/{symbol}/stream")
async def stream_research(symbol: str):
    try:
        sym = research.safe_symbol(symbol)
    except ValueError:
        raise HTTPException(400, "bad symbol")
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def emit(kind: str, payload) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, (kind, payload))

    def work() -> None:
        try:
            d = _cached(sym)
            if d is None:
                llm.start_run()
                d = research.build(sym, progress=lambda step, msg: emit("progress", {"step": step, "msg": msg}))
                _store(sym, d)
            emit("done", d)
        except Exception as e:
            emit("error", {"msg": str(e)})

    threading.Thread(target=work, daemon=True).start()

    async def events():
        while True:
            try:
                kind, payload = await asyncio.wait_for(queue.get(), 15)
            except asyncio.TimeoutError:
                yield ": ping\n\n"          # keep proxies from closing an idle stream during model back-off
                continue
            yield f"event: {kind}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            if kind in ("done", "error"):
                break

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ----------------------------------------------------------------------------- grounded Q&A (Copilot)
_RECENT: dict[str, tuple[float, dict]] = {}     # any-status dossiers, briefly, so follow-up questions are instant

ASK_SCHEMA = {"type": "object", "properties": {
    "answer": {"type": "string", "description": "2-4 sentences, plain English, numbers with units"},
    "cites": {"type": "array", "items": {"type": "integer"}, "description": "numbers of the facts used"},
    "answerable": {"type": "boolean", "description": "false if the facts don't answer the question"}},
    "required": ["answer", "cites", "answerable"]}


def _snapshot_dossier(sym: str, request: Request) -> dict | None:
    """Pre-built dossiers live on the static site; read them instead of rebuilding (instant, no model calls)."""
    base = os.getenv("FINN_SNAPSHOT_BASE")
    if not base:
        ref = request.headers.get("referer") or request.headers.get("origin") or ""
        u = urlparse(ref)
        if u.netloc.endswith(".github.io"):
            base = f"{u.scheme}://{u.netloc}{'/'.join(u.path.split('/')[:2])}"
    if not base:
        return None
    try:
        return json.loads(http.get(f"{base.rstrip('/')}/data/research/{sym}.json", ttl=3600))
    except Exception:
        return None


def _dossier_for(sym: str, request: Request) -> dict:
    hit = _RECENT.get(sym)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    d = _cached(sym) or _snapshot_dossier(sym, request)
    if d is None:
        llm.start_run()
        d = research.build(sym)
        _store(sym, d)
    _RECENT[sym] = (time.time(), d)
    return d


def _chg(m: dict, base_key: str, pct_key: str) -> str:
    v, b = m.get("value"), m.get(base_key)
    if v is not None and b is not None and v * b < 0:
        return "swung to a loss" if v < 0 else "swung to a profit"
    return "n/a" if m.get(pct_key) is None else f"{m[pct_key]:+}%"


def ask_facts(d: dict) -> list[str]:
    """Primary-source facts only: computed numbers, verified quotes, checked promises. No model prose
    (bull/bear) is fed back in, so an answer can't launder an earlier model claim into a 'fact'."""
    s, out = d.get("snapshot", {}), []
    out.append(f"Price ₹{s.get('price')}, P/E {s.get('pe')}, market cap ₹{s.get('mcap_cr')} Cr, ROCE {s.get('roce')}%, ROE {s.get('roe')}%")
    lq = s.get("latest_quarter")
    if lq:
        out.append(f"Latest quarter {lq['period']}: " + "; ".join(
            f"{m['label']} ₹{m['value']} Cr (prior quarter ₹{m.get('prev')} Cr, {_chg(m, 'prev', 'qoq')} QoQ; "
            f"year-ago ₹{m.get('yago')} Cr, {_chg(m, 'yago', 'yoy')} YoY)" for m in lq.get("metrics", [])))
        if lq.get("margin"):
            out.append(f"EBITDA margin {lq['margin']['now']}% in {lq['period']} ({lq['margin'].get('qoq_pp')}pp QoQ, {lq['margin'].get('yoy_pp')}pp YoY)")
        out += [f"Flag: {f}" for f in lq.get("flags", [])]
    for sec in ("trajectory", "balance_sheet", "cash"):
        out += [n["text"] for n in (d.get(sec) or {}).get("notes", [])]
    out += [n["text"] for n in d.get("red_flags", [])]
    mix = d.get("business_mix") or {}
    for seg in mix.get("segments", []) or []:
        out.append(f"Segment {seg.get('name')}: {seg.get('share_pct')}% of revenue {seg.get('note') or ''}".strip())
    for g in d.get("guidance", []):
        if g.get("quote_check") in ("verbatim", "near"):
            out.append(f"[{g['said_in']} earnings call] {g['statement']} — management: \"{g['quote']}\"")
    for p in (d.get("promises") or {}).get("promises", []):
        out.append(f"[promise from {p['said_in']}] {p['promise']} → verdict {p['verdict']}: {p['outcome']} ({p.get('evidence', '')})")
    return [re.sub(r"\s+", " ", x)[:400] for x in out if x]


@app.get("/api/ask")
def ask(symbol: str, q: str, request: Request):
    try:
        sym = research.safe_symbol(symbol)
    except ValueError:
        raise HTTPException(400, "bad symbol")
    q = q.strip()[:300]
    if not q:
        raise HTTPException(400, "empty question")
    try:
        d = _dossier_for(sym, request)
    except Exception as e:
        raise HTTPException(404, f"could not research {sym}: {e}")
    facts = ask_facts(d)
    llm.start_run()
    res = llm.run("extract", task=f"{sym} ask", system=(
        "You answer an investor's question about one Indian listed company using ONLY the numbered facts given, "
        "which come from the company's own filings, financial statements and earnings-call transcripts. "
        "Cite the fact numbers you used. If the facts don't answer the question, say so plainly and set answerable "
        "to false. No outside knowledge, no news, no guesses, no investment advice."),
        prompt=f"Company: {d.get('name')} ({sym})\nQuestion: {q}\n\nFacts:\n" + "\n".join(f"{i}. {f}" for i, f in enumerate(facts, 1)),
        schema=ASK_SCHEMA)
    if not res.ok or not isinstance(res.data, dict):
        return {"status": res.status, "error": res.error, "symbol": sym}
    cites = [c for c in res.data.get("cites", []) if isinstance(c, int) and 1 <= c <= len(facts)]
    partial = res.data.get("answerable") is False
    if not cites:          # model text that can't point at a fact is never shown
        if partial:
            return {"status": "ok", "answer": "The company's own filings and calls don't answer that.",
                    "cites": [], "model": res.model, "symbol": sym}
        return {"status": "unsupported", "symbol": sym}
    return {"status": "ok", "partial": partial, "answer": res.data.get("answer", ""),
            "cites": [facts[c - 1] for c in cites], "model": res.model, "symbol": sym}
