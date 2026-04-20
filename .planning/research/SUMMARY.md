# Research Summary: AI Builder Pulse

**Synthesized:** 2026-04-13
**Sources:** STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md

## Executive Summary

AI Builder Pulse is a fully automated daily newsletter that ingests content from HN, GitHub Trending, Reddit, and RSS feeds, passes candidates through Claude for relevance scoring and categorization, and publishes to Buttondown via REST API — all orchestrated by GitHub Actions cron with zero human involvement. Research confirms this is a well-understood problem class (batch ETL + email publish) with proven open-source tooling and no infrastructure beyond a GitHub repo.

The recommended implementation is a linear stage pipeline: collect → pre-filter → AI filter → format → persist (git) → publish (Buttondown). Each stage has a clean in/out contract (Pydantic models), making individual stages independently testable.

The critical risk is trust: a single hallucinated URL shipped to subscribers irreversibly damages credibility. Claude must be treated as a filter and formatter only, never a URL generator. Every link in output must trace to a field in the raw ingested data.

## Stack

- **Python 3.12 + uv** — runtime and dependency management
- **anthropic 0.94.1** — Claude API client with structured outputs GA, prompt caching
- **httpx 0.28.1** — async HTTP client for all API calls
- **feedparser 6.0.12** — RSS/Atom parsing
- **praw 7.8.1** — Reddit API client
- **pydantic 2.x** — shared schema between pipeline stages and Claude structured output
- **tenacity 9.x** — retry logic for CI reliability
- **No LangChain, no Scrapy, no Playwright** — direct SDK calls only

## Table Stakes (v1)

- Multi-source ingestion (HN, GitHub Trending, Reddit, RSS)
- Claude AI relevance filtering with structured JSON output
- 24-hour freshness enforcement
- Link verification (every URL traces to source data, never Claude-generated)
- Structured categorization (fixed taxonomy)
- Buttondown API publish with idempotency guard
- Daily git commit (JSON + markdown)
- GitHub Actions cron with error alerting

## Should Have (v1.x)

- Weekly best-of digest (requires 7+ committed daily issues)
- Cross-source deduplication (URL normalization)
- Twitter/X ingestion (optional, requires paid API at $200/month)
- Per-source yield metrics/logging

## Defer (v2+)

- Per-subscriber personalization, paid tier, social cross-posting, custom web frontend

## Architecture

Linear batch ETL with git-as-persistence. Typed Pydantic boundaries at every stage: `list[RawItem]` → pre-filter → `list[RawItem]` → Claude → `list[ScoredItem]` → formatter → `str` (Markdown) → git + Buttondown. Single-batch Claude call per run with prompt caching. Weekly rollup reads `issues/YYYY-MM-DD/items.json` files — no code dependency on the daily pipeline.

## Top Pitfalls

1. **Claude fabricates URLs** — every output URL must appear verbatim in input data; post-generation provenance validation required
2. **GitHub Actions silent disable after 60 days** — keepalive action + always-commit pattern from day one
3. **Claude API cost compounding** — pre-filter 60-80% of items before Claude; enable prompt caching; log token counts
4. **Reddit API requires application approval** — submit before writing integration code; public JSON endpoints as fallback
5. **HN Firebase API fan-out** — design concurrency (10-20 parallel) upfront; consider HN Algolia API for date-filtered queries
6. **Cross-source duplicates** — URL normalization dedup before Claude

## Suggested Phase Order

1. **Foundation + Pipeline Scaffold** — GitHub Actions, Pydantic models, secrets config, keepalive
2. **HN Ingestion + Pre-filter** — Concurrent HN collector, freshness filter, URL validation, dedup
3. **Claude AI Filter + Link Verification** — Structured output, URL provenance check, token logging, prompt caching
4. **Formatter + Buttondown Publishing** — Markdown renderer, Buttondown API with idempotency
5. **Additional Sources** — GitHub Trending, Reddit, RSS, Twitter/X (optional behind feature flag)
6. **Git Persistence + Weekly Digest** — Daily issue commit, weekly rollup from last 7 issues

## Research Flags

- **Phase 3:** Prompt engineering for builder-relevance scoring is highest-uncertainty. Consider dedicated research.
- **Phase 5 (Reddit):** API approval timeline is external unknown. Begin application during Phase 1.
- **Twitter/X:** Excluded from v1. $200/month Basic tier. Design for graceful degradation.

## Confidence

| Area | Level |
|------|-------|
| Stack | HIGH |
| Features | HIGH |
| Architecture | HIGH |
| Pitfalls | HIGH |
| **Overall** | **HIGH** |
