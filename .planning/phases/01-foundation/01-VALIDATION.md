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
| **Config file** | vitest.config.ts (Wave 0 installs) |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run --reporter=verbose` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --reporter=verbose`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | AUTO-01 | — | N/A | integration | `npx vitest run` | ❌ W0 | ⬜ pending |
| 1-01-02 | 01 | 1 | AUTO-02 | — | Secrets not in logs | integration | `npx vitest run` | ❌ W0 | ⬜ pending |
| 1-01-03 | 01 | 1 | AUTO-03 | — | N/A | integration | `npx vitest run` | ❌ W0 | ⬜ pending |
| 1-01-04 | 01 | 1 | AUTO-04 | — | Error annotations visible | integration | `npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/setup.test.ts` — stubs for AUTO-01 through AUTO-04
- [ ] `vitest.config.ts` — vitest configuration
- [ ] `vitest` — install as dev dependency

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Cron schedule fires at 6:07 AM ET | AUTO-01 | GitHub Actions cron cannot be unit tested | Verify cron expression `7 10 * * *` in daily.yml |
| Secrets accessible in workflow | AUTO-02 | Requires actual GitHub Actions environment | Push workflow, verify run accesses secrets without error |
| Keepalive prevents 60-day disable | AUTO-03 | Requires 60+ day observation period | Verify keepalive.yml exists with weekly schedule |
| Email notification on failure | AUTO-04 | Requires actual workflow failure | Trigger manual workflow_dispatch with intentional failure |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
