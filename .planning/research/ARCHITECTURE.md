# Architecture Research

**Domain:** Automated content aggregation + newsletter publishing pipeline
**Researched:** 2026-04-13
**Confidence:** HIGH (core patterns) / MEDIUM (GitHub Actions specifics for this use case)

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                      SCHEDULER (GitHub Actions Cron)                 │
│              Triggers daily @ 6AM UTC, weekly @ 7AM UTC Mon          │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                         COLLECTION LAYER                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐  │
│  │  HN API  │  │ GitHub   │  │  Reddit  │  │   RSS    │  │  X/  │  │
│  │(Firebase)│  │Trending  │  │  PRAW/   │  │ feedparser│  │Twitter│ │
│  └────┬─────┘  └────┬─────┘  │  API     │  └────┬─────┘  └──┬───┘  │
│       │             │        └────┬─────┘        │           │      │
└───────┼─────────────┼─────────────┼──────────────┼───────────┼──────┘
        │             │             │              │           │
┌───────▼─────────────▼─────────────▼──────────────▼───────────▼──────┐
│                      RAW ITEMS (normalized schema)                    │
│         {id, source, title, url, score, timestamp, metadata}          │
└────────────────────────────┬────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                        FILTERING LAYER                               │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Pre-filter (deterministic)                                  │    │
│  │  - Freshness gate: drop items older than 24h                 │    │
│  │  - URL validation: no bare domains, no fabricated links      │    │
│  │  - Deduplication: seen-IDs set / URL normalization           │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                             │                                        │
│  ┌──────────────────────────▼──────────────────────────────────┐    │
│  │  Claude API (relevance scoring + categorization)             │    │
│  │  - Single batch call: all items → structured JSON out        │    │
│  │  - Outputs: {category, score, keep, description}             │    │
│  │  - Threshold filter: keep score >= N                         │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│                     FORMATTING LAYER                                  │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Markdown renderer                                           │    │
│  │  - Groups items by category                                  │    │
│  │  - Applies consistent 1-2 sentence description format        │    │
│  │  - Produces daily issue Markdown (email body)                │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
        ┌────────────────────┴────────────────────┐
        │                                         │
┌───────▼───────────────────┐    ┌───────────────▼────────────────────┐
│   PERSISTENCE LAYER        │    │       PUBLISHING LAYER              │
│   Git repo (committed)     │    │       Buttondown API                │
│                            │    │                                     │
│  issues/                   │    │  POST /v1/emails                    │
│    YYYY-MM-DD/             │    │  {subject, body, status:            │
│      issue.md              │    │   "scheduled", publish_date}        │
│      items.json            │    │                                     │
│  weekly/                   │    │  Weekly: separate email_id,         │
│    YYYY-WXX.md             │    │  same endpoint, Mon schedule        │
└────────────────────────────┘    └─────────────────────────────────────┘
        │
        │  (weekly rollup reads committed daily files)
        │
┌───────▼────────────────────────────────────────────────────────────┐
│                      WEEKLY ROLLUP LOGIC                             │
│  - Reads last 7 issues/*/items.json from git                        │
│  - Re-ranks by score across the week                                │
│  - Selects top N per category                                       │
│  - Formats as "Best Of" digest                                      │
└────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Notes |
|-----------|----------------|-------|
| GitHub Actions cron | Schedules and orchestrates; injects secrets | Two workflows: daily + weekly |
| Collectors (per source) | Fetch raw items from one source, return normalized list | One module per source |
| Pre-filter | Freshness, URL validation, deduplication | Deterministic, no AI |
| Claude AI filter | Relevance scoring, categorization, description drafting | Single batch call per run |
| Formatter | Render scored items into final Markdown email body | Pure function, no I/O |
| Git persistence | Commit daily issue files (md + json) to repo | Enables weekly rollup |
| Weekly rollup | Read 7 days of items.json, re-rank, format digest | Reads only committed files |
| Buttondown publisher | POST formatted Markdown email via REST API | Last step; idempotent via status check |

## Recommended Project Structure

```
ai-builder-pulse/
├── .github/
│   └── workflows/
│       ├── daily.yml           # Cron: daily issue generation + publish
│       └── weekly.yml          # Cron: weekly digest generation + publish
├── src/
│   ├── collectors/
│   │   ├── hn.py               # HN Firebase API (top/new stories)
│   │   ├── github_trending.py  # GitHub Trending scrape (no official API)
│   │   ├── reddit.py           # Reddit API via PRAW or pushshift
│   │   ├── rss.py              # feedparser for AI blogs
│   │   └── twitter.py          # Twitter/X API v2 (if available)
│   ├── pipeline/
│   │   ├── prefilter.py        # Freshness, URL validation, dedup
│   │   ├── ai_filter.py        # Claude API batch call: score + categorize
│   │   ├── formatter.py        # Scored items → Markdown email
│   │   └── rollup.py           # Weekly digest from committed daily files
│   ├── publishing/
│   │   └── buttondown.py       # POST to Buttondown /v1/emails
│   ├── models.py               # Pydantic models: RawItem, ScoredItem, Issue
│   └── config.py               # Env vars, thresholds, source config
├── issues/
│   └── YYYY-MM-DD/
│       ├── issue.md            # Final rendered Markdown (email body)
│       └── items.json          # Scored items (weekly rollup input)
├── weekly/
│   └── YYYY-WXX.md             # Weekly digest Markdown
├── tests/
│   ├── test_prefilter.py
│   ├── test_ai_filter.py
│   └── test_formatter.py
└── requirements.txt
```

### Structure Rationale

- **collectors/:** One file per data source. Sources have totally different APIs; isolation means adding/removing a source has no blast radius.
- **pipeline/:** Sequential stages of the pipeline. Each stage is a pure or near-pure function. Tests are trivial.
- **publishing/:** Separated from pipeline so the formatter can be tested without making network calls.
- **issues/ and weekly/:** Committed output artifacts. The git history is the audit log. Weekly rollup reads these files — no separate database needed.
- **models.py:** Shared Pydantic schema prevents silent shape mismatches between stages.

## Architectural Patterns

### Pattern 1: Linear Stage Pipeline

**What:** Data passes through discrete stages in sequence: collect → pre-filter → AI filter → format → persist → publish. Each stage takes a list and returns a list. No stage has side effects except the final two (git commit + Buttondown POST).

**When to use:** Always. This is the correct shape for a batch ETL job. Stages are independently testable.

**Trade-offs:** Simple to reason about and test. Stages cannot parallelize across sources without extra orchestration, but for a daily 300-500 item batch this is not a bottleneck.

**Example:**
```python
items = collect_all_sources()           # [RawItem]
items = prefilter(items)                # [RawItem] (freshness, dedup, URL)
items = ai_filter(items)                # [ScoredItem] (relevance, category, desc)
markdown = format_issue(items)          # str
commit_issue(date, markdown, items)     # side effect: git
publish_to_buttondown(markdown)         # side effect: HTTP POST
```

### Pattern 2: Single Batch Claude Call

**What:** All pre-filtered items are sent to Claude in one API call with structured JSON output. Claude returns a list of scored/categorized items matching the input list by index.

**When to use:** Always for this pipeline. Sending 300+ items in one prompt call (or a few large calls) is dramatically cheaper than per-item calls. The Message Batches API provides 50% cost reduction for async usage.

**Trade-offs:** One big prompt is more fragile than small ones if Claude hallucinates structure. Mitigate with Pydantic validation of the output schema. Prompt caching helps since system prompt is stable across runs (30-98% cache hit rate reported).

**Example structure:**
```python
# Input to Claude:
# System: "You are an AI content curator. Score each item 0-10 for builder relevance.
#          Return JSON array matching input order: [{score, category, keep, description}]"
# User: json.dumps([{title, url, source, score} for item in items])

# Output validated against:
class AIFilterResult(BaseModel):
    score: int  # 0-10
    category: str  # one of: Tools & Launches, Model Releases, ...
    keep: bool
    description: str  # 1-2 sentences
```

### Pattern 3: Git as Persistence + Event Source

**What:** Each daily run commits two files: `issue.md` (rendered email) and `items.json` (structured scored data). The weekly rollup reads the last 7 `items.json` files from the repo filesystem — no database query, no API call, no external state.

**When to use:** When the runtime has no persistent storage (GitHub Actions) and the data volume is small (7 files × ~100KB = trivial). Git provides versioning, history, and auditability for free.

**Trade-offs:** Git is not a database. This works fine at this scale. Searching/querying historical items requires reading files. If the project ever needs cross-week analytics, the JSON files make it easy to load into pandas/SQLite ad hoc.

**Example weekly rollup:**
```python
def load_week_items(issues_dir: Path, n_days: int = 7) -> list[ScoredItem]:
    cutoff = date.today() - timedelta(days=n_days)
    items = []
    for issue_dir in sorted(issues_dir.iterdir()):
        if date.fromisoformat(issue_dir.name) >= cutoff:
            items.extend(json.loads((issue_dir / "items.json").read_text()))
    return items
```

## Data Flow

### Daily Pipeline Flow

```
GitHub Actions cron trigger (06:00 UTC)
    │
    ▼
collect_all_sources() → raw_items: list[RawItem]
    │  (parallel fetches: HN Firebase API, GitHub Trending HTTP,
    │   Reddit API, RSS feedparser, Twitter/X API)
    │
    ▼
prefilter(raw_items) → filtered_items: list[RawItem]
    │  - Drop: published_at < now - 24h
    │  - Drop: url is bare domain or fails regex validation
    │  - Drop: id already in today's seen set (dedup across sources)
    │
    ▼
ai_filter(filtered_items) → scored_items: list[ScoredItem]
    │  - Single Claude API call (or Message Batches if >500 items)
    │  - Structured JSON output enforced with Pydantic
    │  - Drop items where keep=False or score < threshold (e.g., 6)
    │
    ▼
format_issue(scored_items, date) → markdown: str
    │  - Group by category
    │  - Sort by score within category
    │  - Apply consistent template
    │
    ├──► commit_issue(date, markdown, scored_items)
    │      - Write issues/YYYY-MM-DD/issue.md
    │      - Write issues/YYYY-MM-DD/items.json
    │      - git add + git commit (using GITHUB_TOKEN)
    │
    └──► publish_to_buttondown(subject, markdown)
           - POST /v1/emails {subject, body, status:"scheduled",
             publish_date: today@08:00 UTC}
           - Idempotency: check if email for this date already exists first
```

### Weekly Rollup Flow

```
GitHub Actions cron trigger (07:00 UTC Monday)
    │
    ▼
load_week_items(issues/, n_days=7) → all_items: list[ScoredItem]
    │  - Read 7 × items.json from committed files
    │
    ▼
rank_and_select(all_items) → digest_items: list[ScoredItem]
    │  - Re-rank by score across full week
    │  - Select top N per category (e.g., top 3-5)
    │  - Deduplicate by URL across days
    │
    ▼
format_digest(digest_items, week) → markdown: str
    │
    ├──► commit_digest(week, markdown)
    │      - Write weekly/YYYY-WXX.md
    │      - git commit
    │
    └──► publish_to_buttondown(subject, markdown)
           - Same Buttondown endpoint
           - Subject prefix: "Weekly Digest:"
```

### Key Data Flows

1. **Cross-source dedup:** All collectors normalize to the same RawItem schema before dedup. The dedup key is a normalized URL (strip UTM params, normalize trailing slash). HN items also carry the HN story ID as a secondary dedup key.
2. **AI filter → formatter contract:** The ScoredItem schema is the boundary. Formatter only reads `category`, `score`, `description`, `url`, `title`. Changing Claude's prompt internals does not break the formatter as long as the schema is stable.
3. **Git → weekly rollup:** The only coupling is the `items.json` file path convention. The rollup script has no dependency on the collection or AI filter code.

## Scaling Considerations

This pipeline is a batch job, not a web service. Scaling concerns are different.

| Concern | Current (daily batch) | If volume 10x | If multiple newsletters |
|---------|----------------------|---------------|------------------------|
| Collection | Sequential HTTP calls per source, <30s | Add async/concurrent fetching with httpx | Each newsletter gets its own workflow |
| Claude cost | ~$0.10-0.50/day depending on item count and model tier | Switch to Message Batches API for 50% discount; use prompt caching | Per-newsletter cost center |
| Git commit size | ~100KB/day JSON + Markdown | Stays trivial for years | Separate repo per newsletter |
| GitHub Actions minutes | ~5-10 min/run, well within free tier | Still fine | Still fine |
| Buttondown rate limits | 1 email/day send is trivially within any plan | N/A | Separate Buttondown newsletters |

### Scaling Priorities

1. **First bottleneck:** Claude API cost and latency. Mitigate by: (a) aggressive pre-filtering before Claude sees items, (b) Message Batches API for async 50% discount, (c) prompt caching for stable system prompt.
2. **Second bottleneck:** Twitter/X API — rate limits are severe and the API is expensive. Treat X as optional/graceful-degradation from day one.

## Anti-Patterns

### Anti-Pattern 1: Per-Item Claude API Calls

**What people do:** Call Claude once per story to score/filter it.
**Why it's wrong:** 300-500 items/day at even $0.001/call = $0.30-0.50/day minimum; latency adds up; rate limits become a problem. Total daily cost easily exceeds $5 before accounting for description generation.
**Do this instead:** Single batch call passing all pre-filtered items in one prompt. Use structured JSON output to get scores for all items in one response. Fall back to Message Batches API if the prompt exceeds context limits.

### Anti-Pattern 2: Running AI Filter Before Pre-filter

**What people do:** Send all raw items to Claude, including stale or invalid ones.
**Why it's wrong:** HN returns 300-500 stories; many are days old or off-topic. Sending all of them wastes tokens and inflates cost. Pre-filtering deterministically to ~50-100 relevant candidates before Claude call is free.
**Do this instead:** Freshness gate → URL validation → source-specific heuristics (e.g., HN score threshold) → then Claude.

### Anti-Pattern 3: No Idempotency Guard on Publishing

**What people do:** Always POST a new email to Buttondown on each run.
**Why it's wrong:** GitHub Actions cron can fire twice on the same day (duplicate runs, retries). Publishing the same issue twice confuses subscribers.
**Do this instead:** Before publishing, check if an email for today's date already exists via GET /v1/emails?subject=<date>. Skip if already published. Or use a sentinel file in the committed issue directory.

### Anti-Pattern 4: Storing Credentials in Code or Workflow YAML

**What people do:** Hardcode API keys in scripts or echo them in workflow steps.
**Why it's wrong:** Secrets appear in git history or Actions logs, which are visible to contributors.
**Do this instead:** All secrets (ANTHROPIC_API_KEY, BUTTONDOWN_API_KEY, REDDIT_CLIENT_ID, etc.) as repository secrets; accessed via `${{ secrets.NAME }}` in workflow YAML and injected as environment variables to Python scripts.

### Anti-Pattern 5: Monolithic Pipeline Script

**What people do:** One 1000-line script that collects, filters, formats, and publishes.
**Why it's wrong:** Impossible to test individual stages. A bug in the formatter requires re-running collection. Cannot iterate on the AI prompt without running the whole pipeline.
**Do this instead:** Separate modules per stage with clear input/output types. Each stage is independently runnable with fixture data. The workflow YAML composes them.

## Integration Points

### External Services

| Service | Integration Pattern | Gotchas |
|---------|---------------------|---------|
| HN Firebase API | GET `https://hacker-news.firebaseio.com/v0/topstories.json` then per-ID fetches | Rate limit is generous but fetching 500 stories individually takes time; batch with asyncio |
| GitHub Trending | HTTP scrape of `github.com/trending` (no official API) | HTML structure can change; use CSS selectors carefully; the `github-trending-api` third-party service is an alternative |
| Reddit API | PRAW library or OAuth2 REST; subreddits: r/LocalLLaMA, r/MachineLearning, r/AIAssistants | Reddit API terms require OAuth2; free tier has rate limits; PRAW handles this |
| RSS/Atom feeds | feedparser library | Most AI blogs have feeds; Simon Willison, Hugging Face Blog, LangChain, etc.; check feed freshness |
| Twitter/X API | X API v2 Basic or Pro tier | Most expensive integration; rate limits very tight on free tier; treat as optional from day one |
| Claude API | anthropic Python SDK; single messages.create call with structured output | Use `model="claude-opus-4-5"` or `claude-sonnet-4-5` depending on cost/quality tradeoff; prompt caching for system prompt |
| Buttondown API | requests POST to `https://api.buttondown.com/v1/emails` | Auth: `Authorization: Token <key>`; body must be Markdown; status field controls draft vs scheduled vs sent |
| GitHub Actions git | `git config + git add + git commit + git push` using GITHUB_TOKEN | Workflow must have `contents: write` permission; use `actions/checkout` with fetch-depth: 0 |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| collectors → pre-filter | `list[RawItem]` (Pydantic model) | Each collector returns same schema regardless of source |
| pre-filter → ai_filter | `list[RawItem]` (subset) | Same schema; pre-filter only removes, never transforms |
| ai_filter → formatter | `list[ScoredItem]` (Pydantic model) | Adds score, category, keep, description fields |
| formatter → publisher | `str` (Markdown) + `str` (subject) | Formatter knows nothing about Buttondown |
| formatter → git | `str` (Markdown) + `list[ScoredItem]` serialized to JSON | Git persistence is a side effect, not a stage output |
| daily pipeline → weekly rollup | `issues/YYYY-MM-DD/items.json` files on disk | Loose coupling via file convention; rollup has no code dependency on pipeline |

## Build Order (Phase Implications)

The dependency graph drives a natural build order:

```
1. models.py + config.py         (no deps — define contracts first)
         │
2. collectors/ (HN first)        (testable in isolation with fixture data)
         │
3. prefilter.py                  (pure functions, easy to test)
         │
4. ai_filter.py                  (requires Claude API key; can mock in tests)
         │
5. formatter.py                  (pure function; test with fixture ScoredItems)
         │
6. git persistence               (requires GitHub Actions context; test manually)
         │
7. buttondown.py                 (requires API key; test with draft status)
         │
8. GitHub Actions workflows      (wires everything together)
         │
9. Additional collectors         (Reddit, GitHub Trending, RSS, X)
         │
10. weekly rollup                (requires committed daily files to exist first)
```

The HN collector should be built and validated first because it is the highest-value source (300-500 stories/day) and the HN Firebase API is the simplest to integrate. The full end-to-end pipeline can be demonstrated with just HN before adding other sources.

## Sources

- Buttondown API docs: https://docs.buttondown.com/scheduling-emails-via-the-api
- Buttondown API fields (Feb 2026): https://buttondown.com/blog/2026-02-20-newsletter-api-fields
- Python Community News newsletter (Buttondown + GitHub integration): https://github.com/Python-Community-News/Newsletter
- HN Firebase API official docs: https://github.com/HackerNews/API
- Claude API batch processing (50% discount): https://platform.claude.com/docs/en/build-with-claude/batch-processing
- Claude API structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- GitHub Actions secrets management: https://docs.github.com/en/actions/concepts/security/secrets
- Idempotent pipeline patterns: https://dev.to/alexmercedcoder/idempotent-pipelines-build-once-run-safely-forever-2o2o
- Newsletter automation with Hugo + GitHub Actions (state file pattern): https://avelino.run/automating-newsletter-hugo-resend-github-actions-building-active-community/

---
*Architecture research for: automated AI newsletter pipeline*
*Researched: 2026-04-13*
