# FINN: write-up

## What I built

A mobile-first web app (it opens as a dashboard on a laptop) with three tabs, on real data: 18 NSE holdings plus
3 research names, exchange filings for the last 21 days (refreshed every weekday after close), screener statements
and concall transcripts. Research works on any NSE ticker.

- **Brief (Push).** For the window you pick (24h, 3d, 7d or 2 weeks) FINN answers one question first: *how many
  things need me?* At most five full cards; everything else becomes a one-liner or is filed away. Results show
  Revenue, EBITDA, PBT and PAT, QoQ and YoY, with margin and quality flags (lenders get NII). Management changes
  show who the incoming person is, from the filing's own profile annexure. Price and volume alerts run on the
  phone against thresholds you set — a fixed % or σ-based ("unusual for this stock"). You can listen to the brief.
- **Research (Pull).** A dossier on any NSE company: snapshot and segment mix, latest quarter, trajectory, balance
  sheet, cash quality, **promised vs delivered** (every guidance item from the last five calls, quote checked
  against the transcript, verdict against reported numbers), narrative vs numbers, bull vs bear.
- **Copilot.** My answer to "experiment with the interaction model": one box, typed or spoken, that routes by
  intent. *What needs me today* → the brief in one card. *Latest Tata Motors revenue* → finds the company inside the
  sentence, asks "TMCV or TMPV?", then shows the number with QoQ/YoY and the results table, computed — no model.
  *Did Asian Paints deliver on margin guidance* → the checked promise ledger. Open questions → a model answer that
  may only use that company's numbered facts and must cite them; an uncited answer isn't shown. Answers can be read
  aloud, so it works hands-free.

## Key decisions and trade-offs

1. **Filtering is the product, so most of it is deterministic.** ~95% of filings are classified from the exchange's
   own labels plus rules; opaque titles get page 1 of the PDF read; ~5% reach the cheapest model.
2. **Materiality is relative.** Results are scored on their own surprise, orders against company revenue,
   management changes on the role of the named person.
3. **Models read prose, code does arithmetic, code checks the models.** Every quote a model returns is matched
   against the transcript and dropped if it isn't there; a verdict without cited figures becomes "unknown"; figures
   are traced to reported numbers.
4. **Built for the free tier's real limits.** Flash-Lite does the volume, Flash is capped per run, every call has
   bounded retries and a fallback model, and a run budget marks unfinished work "deferred" instead of failing. Each
   dossier and each refresh says what was analysed, by which model, and what's missing.
5. **Copilot answers from computed numbers first, the model last.** Cheaper, faster and impossible to hallucinate
   for the questions investors ask most.

## Architecture (detail in docs/architecture.md)

- **Pipelines:** yfinance EOD prices; exchange announcements (BSE, falling back to NSE — BSE refuses GitHub's
  runners); screener statements and document links; PDFs via pypdf, cached forever. A daily GitHub Actions job
  runs the tests, writes a snapshot with a health report and commits it only if core data is there.
- **LLMs:** Gemini Flash-Lite (bulk/extract) and Flash (judgment), JSON schemas, content-hash cache, usage ledger.
  The research agent plans which documents to read, calls fetchers and parsers, and streams its progress.
- **Cloud:** GitHub Pages (app), Actions (daily job), Render free (research + Copilot API), AI Studio (models).

## What I deliberately left out

- Real web push and intraday feeds; EOD plus the in-app brief proves the idea.
- Annual-report deep reads; transcripts gave the best signal per token for the promise tracker.
- OCR for scanned PDFs, consensus estimates, multi-user auth, and any scraped LinkedIn data.

## Where I'd take it next

1. Per-filing triggers during market hours with push notifications.
2. A multi-year promise ledger feeding a management-credibility score back into materiality.
3. Copilot that compares companies ("Titan vs Trent margins") and remembers the investor's questions.
4. Annual-report reading for related-party transactions and contingent liabilities as red flags.
