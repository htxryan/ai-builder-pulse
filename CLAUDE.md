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

## Technology Stack

This project is **TypeScript on Node.js**, executed directly via `tsx` without
a separate compile step for local runs. The CI entry point is
`node --import tsx src/index.ts` via `pnpm start`. A `pnpm build` compiles to
`dist/` with `tsc -p tsconfig.build.json` for distribution artifacts.

### Core Technologies
| Technology | Version | Purpose |
|---|---|---|
| Node.js | `>= 20.11` (engines pin) | Runtime. GHA `setup-node@v4` with `node-version: 20`. Native `fetch`, `AbortController`, `structuredClone` all available — no polyfills needed. |
| pnpm | `9.12.0` (packageManager pin) | Package manager. `corepack enable` in CI picks up the pinned version from `package.json`. |
| TypeScript | `^5.5` | Strict-typed source. `tsconfig.json` has `"strict": true`; unchecked casts are enforced away by `scripts/check-unchecked-casts.mjs` (`pnpm check:casts`). |
| tsx | `^4.19` | Direct TS execution. `pnpm start` / `pnpm test` run `.ts` files without a prior build step. |
| vitest | `^2.1` | Test runner. 400+ unit/integration tests live under `tests/`. Coverage via `@vitest/coverage-v8`. |
| zod | `^3.25` | Runtime schemas. Every boundary (`RawItem`, `ScoredItem`, curator response, archive `items.json`, GH API) is parsed through zod so invalid payloads fail loudly instead of silently drifting through the pipeline. |
| @anthropic-ai/sdk | `^0.90` | Claude API client. Structured outputs via `messages.parse` with a zod schema. Used in `src/curator/anthropicClient.ts`. |
| fast-xml-parser | `^5.7` | RSS/Atom feed parsing. Chosen over `rss-parser` because it handles malformed feeds better and keeps namespace-prefixed fields (`media:content` etc.) addressable. |
| node-html-parser | `^7.1` | GitHub Trending HTML scrape. Small, fast, DOM-like API. Scope is limited to one page — heavier libraries (cheerio, jsdom) are not justified. |

### Supporting Infrastructure (standard library)
| Capability | How |
|---|---|
| HTTP | Native `fetch` + `AbortSignal.timeout` (Node 20+). No `axios`/`node-fetch`/`undici` dep — see "What NOT to Use". |
| Concurrency | Hand-rolled `mapWithConcurrency` in `src/collectors/concurrency.ts`. Small enough that pulling in `p-limit` would add more risk than value. |
| Retries | Per-callsite in `src/publisher/retry.ts` (exponential backoff). Not a generic decorator — keeps retry policy visible at the callsite. |
| File I/O | `node:fs` with an atomic-write helper (`src/fsAtomic.ts`) that writes to a sibling `.tmp` then renames. Same-filesystem rename is atomic on POSIX. |
| Correlation IDs | `randomBytes` from `node:crypto` (see `src/log.ts` → `makeRunId`). Every log line emitted during a run carries `runId=<id>`. |
| Templating | Plain template literals + string concatenation in `src/renderer/renderer.ts`. The issue body is small and structured; a template engine would be overkill. |

### Development Tools
| Tool | Purpose | Notes |
|---|---|---|
| `actions/checkout@v4` | Repo checkout in CI | Needed by daily/weekly workflows to read prior issue archives and commit new ones. |
| `pnpm/action-setup@v4` | Install pnpm in CI | Respects the `packageManager` field in `package.json`. |
| `actions/setup-node@v4` | Node 20 in CI | Pair with pnpm cache via `cache: pnpm`. |
| `vitest` + `@vitest/coverage-v8` | Test + coverage | `pnpm test` for the full suite; `pnpm test:watch` locally. |
| `tsc --noEmit` | Type check | `pnpm lint` / `pnpm typecheck` — same thing, wired to CI. |
| `scripts/check-unchecked-casts.mjs` | Cast hygiene | Runs via `pnpm check:casts`. Fails if unreviewed `as` casts appear outside documented exceptions. |

### Installation
```bash
corepack enable
pnpm install
```
No build step is required for local runs (`tsx` executes TS directly).

## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|---|---|---|
| native `fetch` | `node-fetch` / `axios` / `undici` explicit | Never — Node 20's global `fetch` covers every callsite in this pipeline. Pull in `undici` only if you need HTTP/2 or long-lived keep-alive pools (neither applies to a daily batch job). |
| `fast-xml-parser` | `rss-parser` / `feedparser-rs` | Only if RSS coverage breaks on a real feed. `fast-xml-parser` has handled every feed in `src/collectors/rss.ts` so far; swap the parser, not the collector. |
| `node-html-parser` | `cheerio` / `jsdom` | Only if GitHub Trending adds JS-rendered content. Both are drop-in for the one scrape callsite, but heavier. |
| hand-rolled `mapWithConcurrency` | `p-limit` / `p-map` | If another concurrency callsite shows up. One utility plus one call is not enough to justify a dep. |
| `zod` | `valibot` / `arktype` / `io-ts` | Only if a future hot path measurably regresses on zod parse. Zod is already a transitive of `@anthropic-ai/sdk`'s structured-output path — using anything else would ship two schema libraries. |
| `tsx` direct execution | `ts-node` / pre-built `dist/` in CI | Use a pre-built `dist/` only if cold-start time on the runner becomes a bottleneck. Current full pipeline is well under GHA's 15-min cap. |

## What NOT to Use
| Avoid | Why | Use Instead |
|---|---|---|
| `axios` / `node-fetch` | Both add a transitive footprint and ergonomic drift from the global `fetch` spec. Node 20 has `fetch`, `Response`, `AbortSignal.timeout`, `FormData` natively. | Native `fetch`. |
| Twitter/X API (Tweepy analog / direct) | Free tier is effectively write-only since 2025. Read access starts at $100/mo. `src/collectors/twitter.ts` exists as a stub that always reports `skipped` in v1. | Re-enable only when a funded plan is in place. See `ENABLE_TWITTER` env flag. |
| Playwright / Puppeteer | Browser automation is unreliable on GHA runners without custom setup. The project constraint is API-and-RSS only. | API fetch + `node-html-parser` for the one HTML scrape (GitHub Trending). |
| LlamaIndex / generic framework wrappers | Adds abstraction overhead for a pipeline that makes a handful of well-scoped Claude calls. Training-time recall on versions is stale. | Direct `@anthropic-ai/sdk` with `messages.parse` + zod. |
| LangChain as a general default | Same rationale as above — don't reach for it for ad-hoc Claude calls. | Direct `@anthropic-ai/sdk`. **Exception:** `@langchain/langgraph` + `@langchain/anthropic` + `@langchain/core` + `deepagents` are pinned as an opt-in curator backend (see `docs/specs/deepagents-migration.md` and `src/curator/deepagent/`). The default Claude path remains `ClaudeCurator` (direct SDK) until M5; DeepAgents is selected only when `CURATOR_BACKEND=deepagents`. |
| community GitHub Trending wrapper APIs | Unofficial, go offline without warning. | Direct HTML scrape of `github.com/trending` via `fetch` + `node-html-parser`. |
| Python (`pydantic`, `feedparser`, `praw`, `PyGithub`, `Jinja2`, `uv`, …) | Earlier stack notes described a Python pipeline. **This project is TypeScript**; the Python stack was discarded. Keep this page honest. | The TypeScript equivalents above. |

## Per-source patterns
- **HN**: HN Algolia (`https://hn.algolia.com/api/v1/search_by_date`) with `numericFilters=created_at_i>…` — no API key, 1000-result pagination.
- **GitHub Trending**: `fetch` + `node-html-parser` against `https://github.com/trending`. No official API exists.
- **Reddit**: OAuth script-app via `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`. Public fallback available via `REDDIT_FALLBACK_PUBLIC=1`. Skip entirely with `REDDIT_DISABLED=1`.
- **RSS**: `fetch` + `fast-xml-parser` across a curated feed list in `src/collectors/rss.ts`.
- **Twitter**: stub; emits `status=skipped` regardless of `ENABLE_TWITTER` value (see `src/collectors/twitter.ts`).
- **Claude curation**: `claude-sonnet-4-6` via `messages.parse` with zod schema for structured output; chunked per `CURATOR_CHUNK_THRESHOLD`; cost ceiling enforced via `CURATOR_MAX_USD`. Model id is pinned in `src/curator/anthropicClient.ts` (`DEFAULT_MODEL`); a consistency test fails if it drifts from this file.
- **Buttondown**: `POST https://api.buttondown.com/v1/emails` with `Authorization: Token $BUTTONDOWN_API_KEY`.

## Version Compatibility
| Package | Minimum | Notes |
|---|---|---|
| Node.js | 20.11 | Required for native `fetch`, `AbortSignal.timeout`, `structuredClone`. |
| TypeScript | 5.5 | `--moduleResolution bundler` / `verbatimModuleSyntax` combo used. |
| zod | 3.23 | `@anthropic-ai/sdk` structured outputs expect zod v3. |
| @anthropic-ai/sdk | 0.90 | `messages.parse` API GA. |
| pnpm | 9.12 | Pinned via `packageManager` — mismatches on CI runners are loud, not silent. |

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.

## Compound-Agent Workflow

This project uses the **compound-agent** system (`npx ca` / `/compound:*` commands) for planning, execution, and lesson capture. See `.claude/CLAUDE.md` and `AGENTS.md` for the full protocol.

### Entry points

- `/compound:spec-dev` — develop a precise spec via Socratic dialogue (EARS + Mermaid)
- `/compound:architect` — decompose a large spec into cook-it-ready epic beads
- `/compound:plan` — create a structured implementation plan with tasks and dependencies
- `/compound:work` — execute an implementation plan by delegating to an agent team
- `/compound:review` — multi-agent code review with severity classification
- `/compound:research` / `/compound:get-a-phd` — deep research producing a structured deliverable
- `/compound:check-that` — search lessons and apply them to current work
- `/compound:prime` — reload workflow context after compaction or session start

### Lesson management (MANDATORY)

- `npx ca search "query"` — call **before** architectural decisions or repeating a past pattern
- `npx ca learn "insight"` — call **after** corrections, self-corrections, or non-obvious discoveries
- Never edit `.claude/lessons/` files directly — use the CLI

### Quality gate for captured lessons

Novel (not already stored) + specific (clear guidance) + actionable (preferred). Workflow: search BEFORE deciding, capture AFTER learning.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Observability

Every log line flows through `src/log.ts` (`log.info` / `log.warn` / `log.error` /
`log.debug`). The helpers emit GitHub Actions annotations (`::error::` /
`::warning::`) alongside JSON so both the Actions UI and a `jq`-piped tail give
useful output.

### Log-level policy

- **`info`** — stage transitions, milestones, and high-level state changes. One
  line per stage entry/exit (`orchestrator start`, `pre-filter complete`,
  `publish ok`, `weekly digest built`). Safe to emit liberally; CI streams it.
- **`warn`** — expected transient failure: timeouts, 5xx, TLS errors, redirect
  resolution failures, per-subreddit fetch errors, item-level zod skips,
  weekly corrupt-day skips, backfill detection, `S-05` source-floor skip.
  These do NOT indicate a bug — they signal degradation the operator may want
  to watch. Always accompanied by a `::warning::` annotation.
- **`error`** — unexpected failure or programmer error that the pipeline cannot
  silently tolerate: uncaught throws, cost-ceiling hits, count-invariant
  violations, missing API key fail-fast, publish 4xx, archivist write failure
  after a successful publish (divergence risk), sentinel write failure,
  link-integrity violations. Always accompanied by a `::error::` annotation
  and typically surfaces via non-zero exit.
- **`debug`** — only emitted when `DEBUG=1`. Reserve for payload traces or
  per-item detail that would otherwise drown the normal log.

### Correlation id

`bindRunId(runId)` is called once per process at the top of every entry point
(`runOrchestrator`, `runWeeklyDigest`). The id is attached to every emitted
line as `runId=<id>` so an operator can `grep runId=<id>` to isolate a single
run's output across interleaved async logs.

### Error taxonomy

All stage-scoped errors extend `OrchestratorStageError` (`src/errors.ts`) with
a `{stage, cause, retryable}` shape. Catchers do `instanceof OrchestratorStageError`
for stage-scoped handling rather than pattern-matching on each concrete
subclass (`PublishError`, `CostCeilingError`, `CollectorTimeoutError`, etc.).

### Deadletter

Curator-level zod validation failures for individual records do NOT abort the
run. The offending `RawItem` + zod issue path are written to
`issues/{runDate}/.skipped-items.json`; the skipped count appears in the GHA
job summary. This preserves an audit trail instead of silently dropping
items.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
