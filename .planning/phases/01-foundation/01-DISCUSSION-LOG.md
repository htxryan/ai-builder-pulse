# Phase 1: Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-13
**Phase:** 01-Foundation
**Areas discussed:** Schedule timing, Error alerting, Project layout, Keepalive strategy, Language choice

---

## Schedule Timing

| Option | Description | Selected |
|--------|-------------|----------|
| 6:07 AM ET daily | Non-zero minute, before US work day, 7 days/week | ✓ |

**User's choice:** Accepted recommendation
**Notes:** None

---

## Error Alerting

| Option | Description | Selected |
|--------|-------------|----------|
| GitHub Actions email | Built-in notifications + workflow annotations | ✓ |
| Slack webhook | External dependency | |

**User's choice:** Accepted recommendation
**Notes:** Keep dependencies minimal for v1

---

## Project Layout

| Option | Description | Selected |
|--------|-------------|----------|
| Flat src/ structure | collectors/, filters/, top-level modules | ✓ |

**User's choice:** Accepted recommendation
**Notes:** None

---

## Keepalive Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Separate weekly workflow | keepalive.yml with trivial operation | ✓ |

**User's choice:** Accepted recommendation
**Notes:** None

---

## Language Choice

| Option | Description | Selected |
|--------|-------------|----------|
| Python 3.12 + uv | Research recommendation, AI/ML ecosystem | |
| TypeScript + Node.js | HTTP/API focus, @anthropic-ai/sdk, Zod schemas | ✓ |

**User's choice:** TypeScript
**Notes:** User challenged the Python default — pipeline is HTTP fetching + API calls + text formatting, not ML. TypeScript preferred for maintainability and type safety.

---

## Claude's Discretion

- Package manager choice
- tsconfig settings
- Node.js version
- GitHub Actions runner OS

## Deferred Ideas

None — discussion stayed within phase scope.
