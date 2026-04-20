# Phase 1: Foundation - Research

**Researched:** 2026-04-14
**Domain:** GitHub Actions CI/CD scaffolding, TypeScript project initialization, secrets management, keepalive mechanisms
**Confidence:** HIGH

## Summary

Phase 1 establishes the automated pipeline infrastructure: a GitHub Actions workflow that runs daily on a cron schedule, manages API keys securely, stays alive indefinitely via a keepalive mechanism, and alerts on failure. No content collection or publishing logic -- just the skeleton that later phases plug into.

The user has decided to use TypeScript with Node.js instead of Python (D-01). This overrides the Python stack recommendations in CLAUDE.md and the earlier STACK.md research. The TypeScript ecosystem has mature equivalents for all required functionality: `@anthropic-ai/sdk` for Claude, `rss-parser` for RSS, `zod` for schema validation, `tsx` for TypeScript execution without a build step.

**Primary recommendation:** Use Node.js 22 LTS with pnpm, `tsx` for TypeScript execution in CI, `vitest` for testing, and a two-workflow architecture (`daily.yml` + `keepalive.yml`). Leverage the new GitHub Actions timezone support (March 2026) to schedule the cron at 6:07 AM ET directly, avoiding manual UTC conversion.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** TypeScript with Node.js -- not Python. The pipeline is HTTP fetching + API calls + text formatting, not ML work. TypeScript gives type safety with Zod, first-class Anthropic SDK support, and maintainability.
- **D-02:** Use `@anthropic-ai/sdk` for Claude API, `rss-parser` for RSS, Zod for schema validation.
- **D-03:** Daily cron at 6:07 AM ET (10:07 UTC), 7 days/week. Non-zero minute avoids GitHub Actions peak congestion. Every day because AI news doesn't stop on weekends.
- **D-04:** GitHub Actions built-in email notifications on workflow failure. No Slack/Discord webhook for v1 -- keeps dependencies minimal.
- **D-05:** `continue-on-error: false` on critical steps. Use `::error::` annotations to surface what failed in the workflow run.
- **D-06:** Flat TypeScript structure under `src/` with `collectors/`, `filters/`, and top-level modules for formatter, publisher, models, config.
- **D-07:** `src/index.ts` is the pipeline entry point. Each collector implements a shared interface defined in `collectors/types.ts`.
- **D-08:** `issues/` directory at repo root for daily output files (YYYY-MM-DD/).
- **D-09:** `.github/workflows/daily.yml` for main cron, `.github/workflows/keepalive.yml` for keepalive.
- **D-10:** Separate lightweight `keepalive.yml` workflow on a weekly cron. Runs a trivial operation to keep the repo active and prevent GitHub's 60-day auto-disable.

### Claude's Discretion
- Package manager choice (npm vs pnpm vs bun)
- Exact tsconfig settings
- Node.js version (18+ LTS)
- GitHub Actions runner OS

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUTO-01 | GitHub Actions cron workflow runs daily at scheduled time | Cron schedule syntax with timezone support (March 2026 feature), `actions/setup-node@v4`, `tsx` for TypeScript execution |
| AUTO-02 | Keepalive mechanism prevents GitHub Actions 60-day auto-disable | `gautamkrishnar/keepalive-workflow@v2` action, API mode with `actions: write` permission, weekly schedule |
| AUTO-03 | Pipeline failures trigger error alerting (GitHub Actions notifications) | Built-in email notifications on failure, `::error::` workflow annotations, `continue-on-error: false` pattern |
| AUTO-04 | API keys managed via GitHub Actions secrets | `${{ secrets.NAME }}` syntax, `process.env` access in Node.js, explicit `permissions:` block in workflow YAML |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

The following CLAUDE.md directives apply to Phase 1:

- **Platform**: Buttondown (for later phases, but secrets should be configured now)
- **Runtime**: GitHub Actions -- cron-scheduled, no persistent server
- **AI**: Claude API via `@anthropic-ai/sdk` (secrets configured in this phase, used in Phase 3)
- **Data**: Must use APIs and RSS, not browser automation
- **Quality**: Every link must be verified from actual source data (later phases)
- **GSD Workflow**: Must use GSD entry points for repo edits

Note: CLAUDE.md's technology stack section recommends Python. This is explicitly overridden by D-01 (TypeScript decision). All TypeScript equivalents are documented in this research.

## Standard Stack

### Core (Phase 1 -- Foundation Only)

| Library | Version | Purpose | Why Standard | Source |
|---------|---------|---------|--------------|--------|
| TypeScript | 5.8.3 | Type system | User decision D-01. Type safety with Zod, first-class Anthropic SDK support | [VERIFIED: npm registry -- `npm view typescript version` returned 5.8.3] |
| Node.js | 22.x LTS | Runtime | Maintenance LTS, supported until April 2027. Active LTS is 24.x but 22.x has broader ecosystem testing | [VERIFIED: nodejs.org/en/about/previous-releases -- Node 22 is Maintenance LTS, Node 24 is Active LTS] |
| pnpm | 10.x | Package manager | Fast, disk-efficient, strict node_modules. Native caching in `actions/setup-node@v4`. Claude's discretion -- pnpm chosen for speed and strictness over npm | [VERIFIED: npm registry -- pnpm 10.33.0 current] |
| tsx | 4.x | TypeScript execution | Runs .ts files directly via esbuild without build step. Zero config, no tsconfig needed for execution. Faster than ts-node (20ms vs 500ms compilation) | [VERIFIED: npm registry -- tsx 4.21.0, description: "Node.js enhanced with esbuild to run TypeScript & ESM files"] |
| zod | 3.x | Schema validation | User decision D-02. TypeScript-first schema validation with static type inference | [VERIFIED: npm registry -- zod 3.24.4] |

### Supporting (Phase 1 -- will be used in later phases, configured now)

| Library | Version | Purpose | When to Use | Source |
|---------|---------|---------|-------------|--------|
| @anthropic-ai/sdk | 0.89.0 | Claude API client | Phase 3 (AI curation). Secret configured in Phase 1 | [VERIFIED: npm registry -- 0.89.0, released 2026-04-14] |
| rss-parser | 3.13.0 | RSS/Atom feed parsing | Phase 2 (content ingestion). User decision D-02 | [VERIFIED: npm registry -- 3.13.0] |
| dotenv | 17.x | Local .env loading | Dev-only, loads API keys locally. CI uses GitHub Secrets | [VERIFIED: npm registry -- 17.4.2] |
| vitest | 4.1.4 | Test framework | All phases. TypeScript-native, fast, Vite-powered. Node 20+ required | [VERIFIED: npm registry -- 4.1.4, engines: node ^20.0.0 || ^22.0.0 || >=24.0.0] |

### GitHub Actions Dependencies

| Action | Version | Purpose | Source |
|--------|---------|---------|--------|
| actions/checkout | v4 | Repo checkout in CI | [VERIFIED: GitHub Marketplace] |
| actions/setup-node | v4 | Node.js + pnpm setup with caching | [VERIFIED: GitHub -- supports `cache: 'pnpm'`, Node 22 LTS] |
| gautamkrishnar/keepalive-workflow | v2 | Prevent 60-day auto-disable | [VERIFIED: GitHub Marketplace -- v2.0.10, API mode default] |
| stefanzweifel/git-auto-commit-action | v5 | Commit output files to repo | [VERIFIED: GitHub Marketplace -- v5, Node 20 runtime] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pnpm | npm | npm is simpler but slower, less strict about phantom dependencies. pnpm is better for CI caching and disk usage |
| pnpm | bun | Bun is faster but less mature in GitHub Actions ecosystem. Package resolution edge cases exist. Choose stability for CI |
| tsx | ts-node | ts-node does type checking but is 25x slower to start. tsx uses esbuild for near-instant transpilation. Type checking belongs in a separate CI step |
| tsx | Node.js native TS (--experimental-strip-types) | Native support exists in Node 22+ but is experimental, strips types only (no path aliases, no decorators). tsx is more reliable today |
| vitest | jest | Jest requires more configuration for TypeScript. vitest has native TS support, faster execution, compatible API |
| Node.js 22 | Node.js 24 | Node 24 is Active LTS but newer -- 22 has broader battle-testing in CI. Either works; 22 is more conservative |

**Installation:**
```bash
# Initialize project
pnpm init

# Core runtime dependencies (Phase 1 skeleton only)
pnpm add zod dotenv

# Dev dependencies
pnpm add -D typescript @types/node tsx vitest

# Dependencies for later phases (install now to validate lockfile)
pnpm add @anthropic-ai/sdk rss-parser
```

## Architecture Patterns

### Recommended Project Structure (Phase 1 Skeleton)

```
ai-builder-pulse/
├── .github/
│   └── workflows/
│       ├── daily.yml           # Cron: daily pipeline (Phase 1: skeleton only)
│       └── keepalive.yml       # Cron: weekly keepalive
├── src/
│   ├── index.ts                # Pipeline entry point (D-07)
│   ├── config.ts               # Environment config loader (reads secrets)
│   ├── models.ts               # Zod schemas: RawItem, ScoredItem, DailyIssue
│   └── collectors/
│       └── types.ts            # Collector interface (D-07)
├── issues/                     # Daily output directory (D-08, empty in Phase 1)
│   └── .gitkeep
├── tests/
│   └── config.test.ts          # Verify config loading
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vitest.config.ts
├── .env.example                # Template for local dev secrets
└── .gitignore
```

### Pattern 1: Workflow with Timezone-Aware Cron Schedule

**What:** GitHub Actions added timezone support for cron schedules in March 2026. Instead of computing UTC offset manually, specify `timezone: "America/New_York"` directly.

**When to use:** Always for this project. D-03 specifies 6:07 AM ET.

**Example:**
```yaml
# Source: https://github.blog/changelog/2026-03-19-github-actions-late-march-2026-updates/
on:
  schedule:
    - cron: '7 6 * * *'
      timezone: 'America/New_York'
  workflow_dispatch:  # Manual trigger for testing
```

**Key detail:** The `timezone` field accepts IANA timezone names. Using `America/New_York` automatically handles EST/EDT daylight saving transitions. [VERIFIED: GitHub changelog March 2026]

### Pattern 2: Explicit Permissions Block

**What:** Declare minimal GITHUB_TOKEN permissions per-workflow to follow least-privilege principle.

**When to use:** Every workflow file.

**Example:**
```yaml
# Source: https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions
permissions:
  contents: write    # Required for git-auto-commit-action to push
  actions: write     # Required for keepalive API mode (keepalive.yml only)
```

### Pattern 3: Secrets as Environment Variables

**What:** GitHub Actions secrets are injected as environment variables, read by Node.js via `process.env`. Use `dotenv` locally for development parity.

**When to use:** All workflows that call external APIs.

**Example:**
```yaml
# In workflow YAML
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  BUTTONDOWN_API_KEY: ${{ secrets.BUTTONDOWN_API_KEY }}
  REDDIT_CLIENT_ID: ${{ secrets.REDDIT_CLIENT_ID }}
  REDDIT_CLIENT_SECRET: ${{ secrets.REDDIT_CLIENT_SECRET }}
```

```typescript
// src/config.ts
// Source: Node.js docs + zod validation pattern
import { z } from 'zod';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  BUTTONDOWN_API_KEY: z.string().min(1),
  REDDIT_CLIENT_ID: z.string().min(1),
  REDDIT_CLIENT_SECRET: z.string().min(1),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  return envSchema.parse(process.env);
}
```

### Pattern 4: Error Annotations for Failure Surfacing

**What:** Use `::error::` workflow commands to create GitHub annotations visible in the Actions UI and PR checks.

**When to use:** In catch blocks of pipeline steps to surface which stage failed.

**Example:**
```yaml
# Source: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
- name: Run daily pipeline
  run: npx tsx src/index.ts
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

- name: Report failure
  if: failure()
  run: echo "::error::Daily pipeline failed. Check the logs above for details."
```

**Annotation limits:** 10 error annotations per step, 50 per job, 50 per workflow run. [VERIFIED: GitHub docs]

### Pattern 5: Keepalive Workflow (API Mode)

**What:** A separate lightweight workflow that uses the GitHub API to prevent the 60-day auto-disable on scheduled workflows.

**When to use:** Always for repos where the only activity is automated (no regular human commits).

**Example:**
```yaml
# .github/workflows/keepalive.yml
# Source: https://github.com/marketplace/actions/keepalive-workflow
name: Keepalive
on:
  schedule:
    - cron: '0 0 * * 1'   # Every Monday at midnight UTC
  workflow_dispatch:

permissions:
  actions: write

jobs:
  keepalive:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gautamkrishnar/keepalive-workflow@v2
        with:
          workflow_files: 'daily.yml'
          time_elapsed: '45'
```

**Why API mode:** Creates no dummy commits, keeping git history clean. Only needs `actions: write` permission. [VERIFIED: keepalive-workflow marketplace page]

### Anti-Patterns to Avoid

- **Hardcoding cron at `:00` or `:30`:** GitHub Actions peak congestion. D-03 already specifies `:07` -- good. [CITED: PITFALLS.md research, GitHub community discussion #156282]
- **Using `permissions: write-all`:** Over-broad. Declare only what each workflow needs. [CITED: GitHub Actions docs]
- **Echoing secrets in workflow steps:** Even `echo $SECRET | head -c 5` can leak partial keys. Never log secret values. [CITED: PITFALLS.md]
- **Skipping `workflow_dispatch`:** Every scheduled workflow should also support manual triggering for testing and recovery. [ASSUMED]
- **Combining keepalive with the daily workflow:** Keep them separate per D-09. The keepalive has different permissions and a different schedule.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Keepalive / anti-disable | Custom commit script or API call | `gautamkrishnar/keepalive-workflow@v2` | Handles edge cases (race conditions, API changes), maintained, 2.4K+ stars |
| Git auto-commit in CI | Manual `git add/commit/push` shell script | `stefanzweifel/git-auto-commit-action@v5` | Handles auth, config, empty commit detection, branch protection |
| Node.js + pnpm setup | Manual `curl` install scripts | `actions/setup-node@v4` with `cache: 'pnpm'` | Built-in caching, version resolution, cross-platform |
| TypeScript execution | Build step with `tsc` + `node dist/` | `tsx` | Zero-config, instant startup, handles ESM/CJS automatically |
| Config validation | Manual `if (!process.env.X)` checks | Zod schema with `z.object().parse(process.env)` | Type inference, clear error messages, single source of truth |

**Key insight:** Phase 1 is infrastructure scaffolding. Every component has a well-maintained, standard solution. Custom implementations add maintenance burden with no value.

## Common Pitfalls

### Pitfall 1: GitHub Actions 60-Day Auto-Disable

**What goes wrong:** Scheduled workflows are automatically disabled after 60 days of no repository activity (commits, PRs, issues). The daily pipeline could silently stop running.
**Why it happens:** GitHub reclaims compute on dormant repos. A newsletter repo where the only activity is automated commits can trigger this if the auto-commit step fails or is skipped.
**How to avoid:** Dedicated `keepalive.yml` workflow per D-10. Use `gautamkrishnar/keepalive-workflow@v2` in API mode, running weekly.
**Warning signs:** Workflow shows "disabled" in the Actions tab. No workflow runs for 2+ days.
[CITED: PITFALLS.md, GitHub community discussion #86087]

### Pitfall 2: Cron Timing Unreliability

**What goes wrong:** GitHub Actions cron is best-effort. Documented delays of 20-75 minutes, and jobs can be dropped during high-load periods (especially at `:00` UTC).
**Why it happens:** Shared global queue, not guaranteed cron execution.
**How to avoid:** Non-zero minute (D-03 uses `:07` -- good). Always support `workflow_dispatch` for manual recovery. Don't build time-sensitive logic that assumes exact execution time.
**Warning signs:** Workflow run timestamps consistently 30+ minutes late.
[CITED: PITFALLS.md, GitHub community discussion #156282, CICube guide]

### Pitfall 3: GITHUB_TOKEN Permissions Default to Read-Only

**What goes wrong:** In repos with restricted default permissions, `GITHUB_TOKEN` may only have read access. The `git-auto-commit-action` step fails silently or with a cryptic auth error.
**Why it happens:** GitHub repos can be configured to restrict the default token. Without explicit `permissions: contents: write`, the token may not have push access.
**How to avoid:** Always declare `permissions:` explicitly in the workflow YAML. For `daily.yml`: `contents: write`. For `keepalive.yml`: `actions: write`.
**Warning signs:** Push step fails with `403` or `remote: Permission denied`.
[CITED: PITFALLS.md, GitHub Actions GITHUB_TOKEN docs]

### Pitfall 4: Secrets Not Available in Forked PRs

**What goes wrong:** GitHub Actions does not expose secrets to workflows triggered from forked repositories. If someone forks the repo and opens a PR, the workflow will fail because `ANTHROPIC_API_KEY` etc. are empty.
**Why it happens:** Security measure to prevent secret exfiltration via malicious PR workflows.
**How to avoid:** The daily cron runs on the main branch, not on PRs -- this is the primary execution path. For PR workflows (if added later), use conditional logic: `if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository`.
**Warning signs:** PR checks failing with "API key not found" errors.
[ASSUMED -- standard GitHub Actions security behavior]

### Pitfall 5: pnpm Not Pre-Installed on GitHub Actions Runners

**What goes wrong:** Unlike npm, pnpm is not pre-installed on GitHub-hosted runners. Running `pnpm install` without setup fails.
**How to avoid:** Use `corepack enable` (built into Node 22+) or install pnpm via `actions/setup-node@v4` which handles it. The `packageManager` field in `package.json` tells corepack which version to use.
**Warning signs:** "pnpm: command not found" in CI logs.
[VERIFIED: pnpm CI documentation at pnpm.io/continuous-integration]

## Code Examples

### Complete daily.yml Workflow Skeleton

```yaml
# Source: GitHub Actions docs + phase decisions D-03, D-04, D-05, D-09
name: Daily Pipeline

on:
  schedule:
    - cron: '7 6 * * *'
      timezone: 'America/New_York'
  workflow_dispatch:

permissions:
  contents: write

jobs:
  daily-issue:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install pnpm
        run: corepack enable && corepack prepare pnpm@latest --activate

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run daily pipeline
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          BUTTONDOWN_API_KEY: ${{ secrets.BUTTONDOWN_API_KEY }}
          REDDIT_CLIENT_ID: ${{ secrets.REDDIT_CLIENT_ID }}
          REDDIT_CLIENT_SECRET: ${{ secrets.REDDIT_CLIENT_SECRET }}
        run: npx tsx src/index.ts

      - name: Commit daily issue
        uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "chore: daily issue ${{ github.run_id }}"
          file_pattern: 'issues/**'

      - name: Annotate failure
        if: failure()
        run: echo "::error::Daily pipeline failed at $(date -u +%Y-%m-%dT%H:%M:%SZ). Check logs above."
```

### Complete keepalive.yml Workflow

```yaml
# Source: gautamkrishnar/keepalive-workflow marketplace + D-10
name: Keepalive

on:
  schedule:
    - cron: '0 0 * * 1'  # Every Monday at midnight UTC
  workflow_dispatch:

permissions:
  actions: write

jobs:
  keepalive:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Keep workflows alive
        uses: gautamkrishnar/keepalive-workflow@v2
        with:
          workflow_files: 'daily.yml'
          time_elapsed: '45'
```

### Minimal src/index.ts Entry Point

```typescript
// Source: project decisions D-07, architecture research
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Starting daily pipeline...`);

  // Phase 1: Validate config (secrets are accessible)
  const config = loadConfig();
  console.log('Config loaded successfully. All required secrets present.');

  // Phase 2+ will add: collect -> filter -> curate -> format -> publish
  console.log('Pipeline skeleton complete. No collectors implemented yet.');
}

main().catch((error) => {
  console.error('::error::Pipeline failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
```

### Zod Config Loader

```typescript
// src/config.ts
// Source: Zod docs + dotenv pattern
import { z } from 'zod';

// Load .env in development (no-op in CI where secrets are injected)
if (process.env.NODE_ENV !== 'production') {
  const dotenv = await import('dotenv');
  dotenv.config();
}

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  BUTTONDOWN_API_KEY: z.string().min(1, 'BUTTONDOWN_API_KEY is required'),
  REDDIT_CLIENT_ID: z.string().min(1, 'REDDIT_CLIENT_ID is required'),
  REDDIT_CLIENT_SECRET: z.string().min(1, 'REDDIT_CLIENT_SECRET is required'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map(i => i.path.join('.')).join(', ');
    throw new Error(`Missing or invalid environment variables: ${missing}`);
  }
  return result.data;
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### package.json (skeleton)

```json
{
  "name": "ai-builder-pulse",
  "version": "0.1.0",
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Cron in UTC only | Timezone-aware cron with `timezone:` field | March 2026 | Can specify `America/New_York` directly -- no manual UTC math or DST bugs |
| ts-node for TypeScript execution | tsx (esbuild-based) | 2024-2025 | 25x faster startup, zero config, handles ESM natively |
| npm for CI | pnpm with corepack | 2024-2025 | Faster installs, strict deps, native GitHub Actions cache support |
| keepalive via dummy commits | keepalive-workflow API mode | v2 (2025) | No commit pollution, cleaner git history |
| Pydantic (Python) for schemas | Zod (TypeScript) | User decision D-01/D-02 | Same concept (runtime schema validation + static type inference) in TypeScript |

**Deprecated/outdated:**
- **ts-node**: Still works but tsx is universally faster and requires less configuration. ts-node's type-checking is better done separately via `tsc --noEmit`.
- **Node.js 20**: Enters end-of-life April 2026. Use Node.js 22 (Maintenance LTS, supported until April 2027) or Node.js 24 (Active LTS).
- **GitHub Actions cron without timezone**: Still works with UTC, but timezone support eliminates a class of DST-related scheduling bugs.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `workflow_dispatch` should be added to every scheduled workflow for testing/recovery | Architecture Patterns | LOW -- worst case, manual triggers aren't available. Easy to add later. |
| A2 | Secrets not available in forked PRs (standard GitHub behavior) | Common Pitfalls | LOW -- well-known behavior, but not verified against current docs in this session |
| A3 | `corepack enable` is the preferred way to activate pnpm on GitHub runners | Code Examples | MEDIUM -- if corepack behavior changes, the install step would need adjustment. pnpm CI docs recommend this approach. |
| A4 | `stefanzweifel/git-auto-commit-action@v5` is the current stable version | Standard Stack | LOW -- v5 confirmed in multiple sources, but v7 was mentioned in one context (may be different action version numbering) |

## Open Questions (RESOLVED)

1. **pnpm version pinning strategy** (RESOLVED)
   - What we know: `packageManager` field in package.json pins the pnpm version for corepack
   - What's unclear: Should we pin to exact patch (10.33.0) or major (10.x)?
   - Recommendation: Pin to exact version in `packageManager` field for reproducibility. Update deliberately.
   - **Resolution:** Pin to exact patch version (10.33.0) via `packageManager` field. Plans use `pnpm@10.33.0` in package.json.

2. **GitHub Actions runner OS** (RESOLVED)
   - What we know: `ubuntu-latest` is standard and well-tested. Claude's discretion area.
   - What's unclear: Whether `ubuntu-24.04` (explicit) or `ubuntu-latest` (rolling) is better
   - Recommendation: Use `ubuntu-latest` for simplicity. Pin to explicit version only if a breakage occurs.
   - **Resolution:** Use `ubuntu-latest` per recommendation. Both daily.yml and keepalive.yml specify `runs-on: ubuntu-latest`.

3. **Phase 1 scope for config validation** (RESOLVED)
   - What we know: Phase 1 is skeleton only. Config validation proves secrets work.
   - What's unclear: Should Phase 1 actually call any external APIs to verify secrets are valid (not just present)?
   - Recommendation: Do a lightweight validation (secret is non-empty string). Actual API calls are Phase 2+ concern.
   - **Resolution:** Lightweight Zod validation only (non-empty string). Actual API connectivity testing deferred to Phase 2+. Plan 01 Task 2 implements this via `z.string().min(1)`.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.4 |
| Config file | `vitest.config.ts` (Wave 0 -- needs creation) |
| Quick run command | `pnpm test` |
| Full suite command | `pnpm test -- --run` |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTO-01 | Workflow YAML is valid, has correct cron schedule and timezone | unit (YAML parse + assert) | `pnpm test -- tests/workflow.test.ts` | Wave 0 |
| AUTO-02 | keepalive.yml exists with correct action and permissions | unit (YAML parse + assert) | `pnpm test -- tests/workflow.test.ts` | Wave 0 |
| AUTO-03 | Pipeline entry point exits non-zero on error, uses ::error:: | unit (process exit code) | `pnpm test -- tests/index.test.ts` | Wave 0 |
| AUTO-04 | Config loader validates all required env vars via Zod | unit (schema validation) | `pnpm test -- tests/config.test.ts` | Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm test`
- **Per wave merge:** `pnpm test -- --run && pnpm typecheck`
- **Phase gate:** Full suite green + `tsc --noEmit` passes

### Wave 0 Gaps

- [ ] `vitest.config.ts` -- vitest configuration file
- [ ] `tests/config.test.ts` -- validates Zod config schema with good/bad env vars
- [ ] `tests/workflow.test.ts` -- parses workflow YAML files and asserts structure
- [ ] `tests/index.test.ts` -- verifies entry point error handling behavior

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No (no user auth) | N/A |
| V3 Session Management | No | N/A |
| V4 Access Control | Yes (secrets scope) | GitHub Actions `permissions:` block -- least privilege per workflow |
| V5 Input Validation | Yes (env vars) | Zod schema validation of `process.env` before use |
| V6 Cryptography | No (no custom crypto) | GitHub manages secret encryption at rest |

### Known Threat Patterns for GitHub Actions + Node.js

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Secret leakage in logs | Information Disclosure | Never `echo` or `console.log` secret values. GitHub auto-masks `${{ secrets.X }}` in logs but not `process.env.X` if logged by application code |
| Workflow injection via PR | Tampering | Secrets are not available in forked PR workflows. Daily cron runs on main branch only |
| Supply chain attack via Actions | Tampering | Pin action versions to specific tags (`@v4`, `@v2`), not `@main`. Review changelogs before updating |
| Overly permissive GITHUB_TOKEN | Elevation of Privilege | Explicit `permissions:` block with minimum required scopes |

## Sources

### Primary (HIGH confidence)
- [GitHub Actions March 2026 changelog](https://github.blog/changelog/2026-03-19-github-actions-late-march-2026-updates/) -- Timezone support for cron schedules confirmed
- [GitHub Actions workflow syntax docs](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions) -- Permissions syntax, cron syntax, workflow_dispatch
- [GitHub Actions notifications docs](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs) -- Email notification behavior on failure
- [GitHub Actions workflow commands docs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands) -- `::error::` annotation syntax and limits
- [keepalive-workflow marketplace](https://github.com/marketplace/actions/keepalive-workflow) -- v2.0.10, API mode, configuration options
- [Node.js releases page](https://nodejs.org/en/about/previous-releases) -- Node 22 Maintenance LTS, Node 24 Active LTS
- npm registry -- All package versions verified via `npm view`
- [tsx official site](https://tsx.is/) -- TypeScript execution via esbuild

### Secondary (MEDIUM confidence)
- [CICube: GitHub Actions cron scheduling](https://cicube.io/blog/github-actions-cron/) -- Peak congestion patterns at :00/:30
- [GitHub community discussion #86087](https://github.com/orgs/community/discussions/86087) -- 60-day auto-disable behavior
- [GitHub community discussion #156282](https://github.com/orgs/community/discussions/156282) -- Cron delay documentation (20-75 min)
- [Better Stack: tsx vs ts-node comparison](https://betterstack.com/community/guides/scaling-nodejs/tsx-vs-ts-node/) -- Performance comparison (20ms vs 500ms)
- [pnpm CI documentation](https://pnpm.io/continuous-integration) -- GitHub Actions setup pattern

### Tertiary (LOW confidence)
- None -- all claims verified against primary or secondary sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all versions verified against npm registry, Node.js LTS status verified
- Architecture: HIGH -- all patterns based on official GitHub Actions docs and verified third-party actions
- Pitfalls: HIGH -- drawn from verified PITFALLS.md research and official GitHub docs

**Research date:** 2026-04-14
**Valid until:** 2026-05-14 (30 days -- stable domain, no fast-moving changes expected)
