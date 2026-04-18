# ai-builder-pulse

Newsletter for AI builders — fully automated daily digest ingesting HN, GitHub Trending, Reddit, and AI-blog RSS feeds; curated by Claude; published via Buttondown.

## Development

```bash
pnpm install
pnpm lint          # tsc --noEmit
pnpm test          # vitest
pnpm build         # compile to dist/
DRY_RUN=1 pnpm start  # run orchestrator without publishing
```

## Environment Variables

| Name | Purpose |
|------|---------|
| `DRY_RUN` | `1` = skip Buttondown POST, git commit, `.published` write. Bypasses S-03 sentinel check. |
| `MIN_ITEMS_TO_PUBLISH` | Minimum kept ScoredItems to publish (S-02). Default 5. |
| `MIN_SOURCES` | Minimum successful collectors required (S-05). Default 2. |
| `ANTHROPIC_API_KEY` | Claude API key (curator). |
| `BUTTONDOWN_API_KEY` | Buttondown publish key. |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Reddit OAuth. |

## Retention Policy (U-11)

Daily issues are persisted as `issues/YYYY-MM-DD/{issue.md, items.json, .published}` and committed to this repo indefinitely.

Revisit retention when either threshold is hit:
- `issues/` exceeds **100 MB**, or
- **5 years** of accumulated issues.

At that point options are: shallow-clone of a rolling window, migrate older issues to a separate archive repo, or prune pre-rollup items.json while keeping rendered issue.md.

## Architecture

See:
- `docs/specs/ai-builder-pulse.md` — system spec (EARS + contracts)
- `docs/specs/ai-builder-pulse-decomposition.md` — epic decomposition

Epic E1 (this milestone) delivers: TS scaffold, Orchestrator entry with immutable `runDate` (UTC), Mock Curator pass-through, three GHA workflows (daily cron 06:07 UTC, weekly Monday, keepalive). Real collectors (E2), real Claude curation (E4), Buttondown publish (E5), git persistence (E6) ship in later epics.
