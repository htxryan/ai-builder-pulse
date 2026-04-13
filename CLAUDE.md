<!-- GSD:project-start source:PROJECT.md -->
## Project

**AI Builder Pulse**

A fully automated daily newsletter for software engineers building AI-powered tools and workflows. Scans Hacker News, Twitter/X, GitHub Trending, Reddit, and key AI blogs every day, uses Claude API to filter and curate for builder relevance, and publishes directly to Buttondown with zero human intervention. Daily issues are committed to the repo as files, and a weekly digest rolls up the best items.

**Core Value:** Practitioners building with AI get a comprehensive, trustworthy daily briefing of everything relevant — tools, models, techniques, infrastructure — without having to scan dozens of sources themselves.

### Constraints

- **Platform**: Buttondown — chosen for its publish API and markdown-native support
- **Runtime**: GitHub Actions — cron-scheduled, no persistent server
- **AI**: Claude API — for content filtering, relevance scoring, and formatting
- **Data**: Must use APIs and RSS, not browser automation (GitHub Actions environment)
- **Quality**: Every link must be verified from actual source data — no hallucinated URLs
- **Freshness**: Content must be from last 24 hours only
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Python | 3.12 | Runtime | GitHub Actions ships Python 3.12/3.13 by default; stable, well-cached. 3.14 exists but adds no value for this use case and has fewer tested Action images. |
| anthropic SDK | 0.94.1 | Claude API client | Official SDK, fully typed, native async, structured outputs via `output_config.format` (now GA — no beta header needed). Required for content filtering and curation. |
| httpx | 0.28.1 | HTTP client | Requests-compatible API + native async support in one library. Replaces `requests` for this project because several data sources benefit from concurrent fetch. Keep one HTTP client. |
| feedparser | 6.0.12 | RSS/Atom feed parsing | Battle-tested, handles malformed feeds, auto-normalizes across RSS and Atom variants. Simon Willison's feed, AI blogs, and Arxiv all need this. |
| praw | 7.8.1 | Reddit API | Official Python Reddit API Wrapper. Handles OAuth, rate limiting automatically. Use for r/LocalLLaMA, r/MachineLearning, r/mlops. |
| PyGithub | 2.9.0 | GitHub REST API | Typed GitHub API client. Used for fetching repo metadata (stars, language, description) once trending repo names are scraped. NOT for the trending list itself — see below. |
| Jinja2 | 3.1.6 | Template rendering | Standard Python templating. Used to render markdown and HTML email body from structured data. Widely used, no surprises, works headlessly. |
| Markdown | 3.10.2 | Markdown to HTML | Converts issue body markdown to HTML if Buttondown plain-text mode needs it. Latest stable as of Feb 2026. |
| uv | latest (pinned in CI) | Dependency management + venv | Fastest Python package installer/resolver, native GitHub Actions integration via `astral-sh/setup-uv`. Replaces pip+venv for CI. Lock file support eliminates environment drift. |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pydantic | 2.x (latest) | Data validation and schema | Defining `NewsItem`, `DailyIssue` schemas. Pairs directly with Claude structured outputs — use the same Pydantic model client-side to parse Claude JSON responses. |
| python-dateutil | 2.9.x | Date parsing | Parsing inconsistent datetime strings from RSS feeds and APIs into UTC datetime objects for freshness filtering. |
| beautifulsoup4 | 4.x (latest) | HTML scraping | Required only for GitHub Trending (no official API). Parses `https://github.com/trending` HTML. Keep scope narrow — only one scraping target uses this. |
| lxml | 5.x (latest) | Fast XML/HTML parser | Parser backend for BeautifulSoup. Faster than html.parser; needed for reliability on GitHub's HTML. |
| python-dotenv | 1.x (latest) | Local .env loading | Loads API keys from `.env` during local development. GitHub Actions uses repo Secrets — dotenv is dev-only, not needed in CI. |
| tenacity | 9.x (latest) | Retry logic | Decorator-based retries with exponential backoff for HTTP calls and API requests. Critical for CI reliability — a transient 429 or 503 must not fail the entire daily run. |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| `astral-sh/setup-uv` | GitHub Actions uv setup | Pin to `v7`. Set `enable-cache: true` with `uv.lock` as cache key. Cuts cold-start install time from ~60s to ~5s. |
| `actions/checkout` | Repo checkout in CI | Use `v4`. Required for reading prior daily issue files (weekly digest) and committing new ones. Set `token: ${{ secrets.GITHUB_TOKEN }}` for push-back. |
| stefanzweifel/git-auto-commit-action | Commit output files to repo | Pin to `v5`. Handles `git add`, `git commit`, `git push` in one Action step. Used to persist daily issue `.md` and `.json` files. |
| pytest | 8.x | Test runner | Unit tests for pipeline stages: filtering logic, link verification, template rendering. |
| pytest-asyncio | 0.x (latest) | Async test support | Required for testing async fetch functions. |
## Installation
# Core runtime dependencies
# Dev dependencies
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| httpx | requests | Never — httpx is a superset with async. No reason to use requests if httpx is already in the stack. |
| httpx | aiohttp | If the entire pipeline were async-first from the ground up. httpx covers both sync and async, so aiohttp adds no benefit here. |
| uv | pip + venv | Never in CI. pip is slower and lacks a lock file by default. Only use pip if uv is unavailable in a constrained environment. |
| feedparser | custom RSS parsing with httpx+lxml | Only if you need streaming or feed discovery logic feedparser doesn't support. feedparser handles 99% of public feeds without configuration. |
| praw | direct Reddit API via httpx | If Reddit revokes third-party app access again (happened in 2023). praw is official and maintained by Reddit staff alumni — prefer it while it works. |
| Jinja2 | string formatting / f-strings | Never for templates. f-strings at scale become unmaintainable. Jinja2 separates template from logic cleanly. |
| structured outputs (output_config.format) | instructor library | If you need more complex Pydantic retry/validation logic. For this project's batch curation use case, native structured outputs are sufficient and add no dependency. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Tweepy + official Twitter/X API | The free tier is effectively write-only as of 2025. Read access for search requires Basic plan ($100/mo) at minimum, Pro ($5K/mo) for volume. Unsustainable for a daily newsletter. | RSS feeds from AI Twitter accounts via nitter alternatives, or simply skip Twitter as a source in v1. Twitter is deprioritized — HN + Reddit + GitHub Trending + RSS blogs are higher signal. |
| Substack API | Does not exist. No programmatic publishing endpoint. | Buttondown (already decided). |
| Scrapy | Heavy framework overhead for what are essentially 5-6 targeted fetches per day. Brings its own async model that conflicts with GitHub Actions straightforward scripting. | httpx for direct HTTP, feedparser for RSS, beautifulsoup4 for the one page-scrape target (GitHub Trending). |
| Playwright / Selenium | Browser automation doesn't work reliably in GitHub Actions without custom runner setup and is slow. | API-based fetch exclusively. The project constraint is no browser automation. |
| LangChain / LlamaIndex | Adds significant abstraction overhead for a pipeline that makes a handful of well-defined Claude API calls. Training data may be stale on LangChain versions. | Direct anthropic SDK calls with structured outputs. Stay at the API layer. |
| community GitHub Trending APIs (ghapi.huchen.dev etc.) | Unofficial, routinely go offline without warning. A broken third-party dependency will silently kill the daily newsletter. | Direct BeautifulSoup scrape of github.com/trending. This page is stable HTML and doesn't require login. |
| asyncpraw (async PRAW) | Adds complexity without benefit for a daily batch job that runs once. Not needed unless the pipeline becomes a long-running async service. | Synchronous praw in a normal Python script. |
## Stack Patterns by Variant
- Use the HN Algolia Search API (`https://hn.algolia.com/api/v1/search_by_date`) with `numericFilters=created_at_i>[unix_timestamp_24h_ago]`
- Returns up to 1,000 results with pagination; no API key required
- The Firebase API (`hacker-news.firebaseio.com/v0`) is the official API but requires fetching each story individually — slower for 300-500 stories. Algolia is the right choice for daily batch.
- Scrape `https://github.com/trending?since=daily&spoken_language_code=en` with httpx + BeautifulSoup
- GitHub's HTML for the trending page is stable and does not require authentication for public viewing
- Use PyGithub only for follow-up metadata enrichment on repos that pass the relevance filter
- Use read-only OAuth (script-type app) via praw. Does not require a Reddit account to be logged in, just app credentials.
- Subreddits: r/LocalLLaMA, r/MachineLearning, r/mlops, r/OpenAI, r/LangChain — query `.hot()` or `.new()` with `time_filter='day'`
- feedparser handles all well-known AI blogs (Simon Willison logbook, Towards Data Science, The Batch, etc.)
- Pass a list of feed URLs to feedparser.parse() and filter `entry.published_parsed` against a 24-hour window
- Use `claude-sonnet-4-6` (cost-effective, fast) with structured outputs
- Use `output_config.format` with a JSON schema defining the `NewsItem` fields
- Batch items in a single prompt per source (don't call Claude per item — batch to 20-50 items per call)
- No beta header needed for structured outputs as of 2026
- POST to `https://api.buttondown.com/v1/emails` with `Authorization: Token YOUR_API_KEY`
- Set `status: "about_to_send"` to publish immediately, or `status: "scheduled"` + `publish_date` for timed send
- Body is markdown-native; no HTML conversion needed
- Budget $100/month for Basic API tier, or use a third-party scraping service (TwitterAPI.io ~$0.15/1K tweets)
- Do NOT include Twitter as a v1 source without a funded plan. It will fail silently or raise auth errors and break the pipeline.
## Version Compatibility
| Package | Compatible With | Notes |
|---------|-----------------|-------|
| anthropic 0.94.x | Python 3.9+ | Confirmed on PyPI. Use `output_config.format` (not deprecated `output_format`). |
| pydantic 2.x | anthropic 0.94.x | Pydantic v2 is expected by anthropic SDK's typed response models. Do not use pydantic v1. |
| feedparser 6.0.12 | Python 3.6+ | No known conflicts with httpx or praw. |
| praw 7.8.1 | Python 3.8+ | No asyncpraw in stack — no conflict. |
| PyGithub 2.9.0 | Python 3.9+ | Requires `requests` as a transitive dep — will be installed automatically. Does not conflict with httpx being the primary client. |
| uv / astral-sh/setup-uv@v7 | GitHub Actions ubuntu-latest, macos-latest | Pin uv version in setup action for reproducibility. |
## Sources
- PyPI: `anthropic` — version 0.94.1, released 2026-04-13 (verified)
- PyPI: `httpx` — version 0.28.1 (verified)
- PyPI: `feedparser` — version 6.0.12, released 2025-09-10 (verified)
- PyPI: `praw` — version 7.8.1, released 2024-10-25 (verified)
- PyPI: `PyGithub` — version 2.9.0, released 2026-03-22 (verified)
- PyPI: `Jinja2` — version 3.1.6 (verified)
- PyPI: `Markdown` — version 3.10.2, released 2026-02-09 (verified)
- platform.claude.com/docs/en/build-with-claude/structured-outputs — Structured outputs GA, `output_config.format`, supported models confirmed (verified)
- docs.buttondown.com — API endpoint, auth method, status options confirmed (verified)
- docs.astral.sh/uv/guides/integration/github — GitHub Actions uv integration pattern (verified)
- hn.algolia.com/api — HN Algolia search endpoint for date-filtered queries (MEDIUM confidence — page did not load parameters directly, but endpoint is widely documented)
- GitHub community discussion #161519 — Confirmed no official GitHub Trending API endpoint (verified)
- WebSearch: Twitter API pricing tiers and free tier read restrictions (MEDIUM confidence — multiple sources agree)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
