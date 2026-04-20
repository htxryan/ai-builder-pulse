---
phase: 1
slug: foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-14
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x |
| **Config file** | vitest.config.ts (Plan 01 Task 1 creates) |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test`
- **After every plan wave:** Run `pnpm test && pnpm typecheck`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-T1 | 01 | 1 | AUTO-04 | T-01-01, T-01-03 | Secrets never logged; .env in .gitignore | unit | `pnpm install --frozen-lockfile && pnpm typecheck` | N/A (project init) | pending |
| 01-01-T2 | 01 | 1 | AUTO-04 | T-01-01, T-01-02 | Config validates secrets without logging values | unit | `pnpm typecheck && pnpm test` | tests/config.test.ts (created in this task) | pending |
| 01-02-T1 | 02 | 2 | AUTO-01, AUTO-02, AUTO-03, AUTO-04 | T-02-01, T-02-02, T-02-03 | Secrets as ${{ secrets.X }}, least-privilege permissions | integration | `node -e "...yaml parse..." ` (see plan verify) | N/A (YAML files) | pending |
| 01-02-T2 | 02 | 2 | AUTO-01, AUTO-02, AUTO-03, AUTO-04 | T-02-04, T-02-05 | Tests validate YAML structure and error annotations | unit | `pnpm test` | tests/workflow.test.ts, tests/index.test.ts (created in this task) | pending |

*Status: pending / green / red / flaky*

---

## Requirement-to-Plan Coverage

| Requirement | Plan | Task(s) | Coverage |
|-------------|------|---------|----------|
| AUTO-01 | 02 | T1 (daily.yml cron), T2 (workflow.test.ts) | Full |
| AUTO-02 | 02 | T1 (keepalive.yml), T2 (workflow.test.ts) | Full |
| AUTO-03 | 02 | T1 (::error:: annotation step), T2 (index.test.ts) | Full |
| AUTO-04 | 01, 02 | 01-T2 (Zod config loader), 02-T1 (secrets in workflow env), 02-T2 (config.test.ts) | Full |

---

## Wave 0 Requirements

- [ ] `vitest.config.ts` — vitest configuration (created by Plan 01 Task 1)
- [ ] `tests/config.test.ts` — validates Zod config schema (created by Plan 01 Task 2)
- [ ] `tests/workflow.test.ts` — parses workflow YAML and asserts structure (created by Plan 02 Task 2)
- [ ] `tests/index.test.ts` — verifies entry point error handling (created by Plan 02 Task 2)

*All Wave 0 test files are created within their respective plan tasks.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Cron schedule fires at 6:07 AM ET | AUTO-01 | GitHub Actions cron cannot be unit tested end-to-end | Verify cron expression `7 6 * * *` with timezone `America/New_York` in daily.yml; trigger via workflow_dispatch to confirm workflow runs |
| Secrets accessible in workflow runtime | AUTO-04 | Requires actual GitHub Actions environment with secrets configured | Push workflow to GitHub, trigger workflow_dispatch, verify run completes without "missing env var" errors |
| Keepalive prevents 60-day disable | AUTO-02 | Requires 60+ day observation period | Verify keepalive.yml exists with weekly schedule targeting daily.yml |
| Email notification on failure | AUTO-03 | Requires actual workflow failure in GitHub Actions | Trigger manual workflow_dispatch with env vars intentionally missing to produce failure; verify email notification received |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
