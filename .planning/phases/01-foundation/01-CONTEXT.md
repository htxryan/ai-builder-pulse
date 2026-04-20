# Phase 1: Foundation - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<domain>
## Phase Boundary

GitHub Actions scaffold, secrets config, keepalive, and error alerting. The automated pipeline infrastructure exists and can be triggered on a daily schedule without human intervention. No content collection or publishing in this phase — just the skeleton that phases 2-5 plug into.

</domain>

<decisions>
## Implementation Decisions

### Language & Runtime
- **D-01:** TypeScript with Node.js — not Python. The pipeline is HTTP fetching + API calls + text formatting, not ML work. TypeScript gives type safety with Zod, first-class Anthropic SDK support, and maintainability.
- **D-02:** Use `@anthropic-ai/sdk` for Claude API, `rss-parser` for RSS, Zod for schema validation.

### Schedule Timing
- **D-03:** Daily cron at 6:07 AM ET (10:07 UTC), 7 days/week. Non-zero minute avoids GitHub Actions peak congestion. Every day because AI news doesn't stop on weekends.

### Error Alerting
- **D-04:** GitHub Actions built-in email notifications on workflow failure. No Slack/Discord webhook for v1 — keeps dependencies minimal.
- **D-05:** `continue-on-error: false` on critical steps. Use `::error::` annotations to surface what failed in the workflow run.

### Project Layout
- **D-06:** Flat TypeScript structure under `src/` with `collectors/`, `filters/`, and top-level modules for formatter, publisher, models, config.
- **D-07:** `src/index.ts` is the pipeline entry point. Each collector implements a shared interface defined in `collectors/types.ts`.
- **D-08:** `issues/` directory at repo root for daily output files (YYYY-MM-DD/).
- **D-09:** `.github/workflows/daily.yml` for main cron, `.github/workflows/keepalive.yml` for keepalive.

### Keepalive Strategy
- **D-10:** Separate lightweight `keepalive.yml` workflow on a weekly cron. Runs a trivial operation to keep the repo active and prevent GitHub's 60-day auto-disable.

### Claude's Discretion
- Package manager choice (npm vs pnpm vs bun)
- Exact tsconfig settings
- Node.js version (18+ LTS)
- GitHub Actions runner OS

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

No external specs — requirements fully captured in decisions above.

### Project Context
- `.planning/PROJECT.md` — Project vision, constraints, key decisions
- `.planning/REQUIREMENTS.md` — AUTO-01 through AUTO-04 requirements for this phase
- `.planning/research/STACK.md` — Technology recommendations (note: research assumed Python — TypeScript decision overrides stack choices, but architecture patterns still apply)
- `.planning/research/PITFALLS.md` — GitHub Actions gotchas (60-day disable, cron timing, permissions)
- `.planning/research/ARCHITECTURE.md` — Pipeline stage design, component boundaries

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — greenfield project. No existing code beyond config directories.

### Established Patterns
- None yet — this phase establishes the patterns.

### Integration Points
- GitHub Actions secrets will be consumed by phases 2-5 (ANTHROPIC_API_KEY, BUTTONDOWN_API_KEY, REDDIT credentials)
- `src/collectors/types.ts` interface will be implemented by each source collector in Phase 2
- `src/models.ts` Zod schemas will be shared across all pipeline stages

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-04-13*
