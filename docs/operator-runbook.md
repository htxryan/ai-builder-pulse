# Operator runbook

A daily/weekly run finishes with a single **status** value, and usually a
**reason** code, surfaced in:

1. The GitHub Actions step summary (top of the "Summary" tab — see
   `$GITHUB_STEP_SUMMARY`), rendered by `src/runSummary.ts`.
2. The final log line (`"orchestrator done"` / `"weekly done"`).
3. The exit code (non-zero on any `failed*` status).

Every line in a single run carries the same `runId`, e.g.
`runId=20260418T0607-abcdef`. Grep on it to isolate one run's output from
interleaved concurrent jobs or from consecutive cron runs.

This document lists every status value, what it means, whether a subscriber
was affected, and the first three troubleshooting steps.

## Daily statuses (`OrchestratorResult.status`)

### `published`

**Meaning.** Buttondown accepted the email and the archive (issue.md,
items.json, .published sentinel) landed atomically.

**Subscriber impact.** Email sent successfully.

**Troubleshooting.** No action required. If downstream consumers report a
discrepancy, cross-check `publishId` in the summary against Buttondown's
admin dashboard.

### `published_archive_failed`

**Meaning.** Buttondown accepted the email (subscribers received it) but the
local archive write failed. The `.published` sentinel is absent, so the
**next** cron run will detect this via the E-06 backfill scan.

**Subscriber impact.** Email sent. The issue.md may or may not have been
committed depending on when the failure occurred.

**Troubleshooting.**
1. Search the log for `archivist write failed` — the message includes the
   underlying fs error.
2. Check disk space / permissions on the workflow runner (rare).
3. Confirm the next cron run's backfill scan detects the unpublished day.
   The backfill will re-emit the archive; **do not re-run the daily
   manually** — the sentinel check alone is not enough to prevent a
   duplicate send without the `.published` file.

### `dry_run`

**Meaning.** `DRY_RUN=1` was set. The pipeline ran through rendering but
stopped before publishing. Useful for preview builds and CI smoke tests.

**Subscriber impact.** None.

**Troubleshooting.** Inspect the rendered subject/body in the log
(`"[DRY_RUN] would publish"`). Nothing to fix — this is informational.

### `idempotent_skip`

**Meaning.** The `.published` sentinel for this `runDate` already exists.
The orchestrator bailed before collection (cheap, cost-free skip).

**Subscriber impact.** None (the original publish for this date already
occurred).

**Troubleshooting.**
1. Confirm this is a duplicate cron fire, not a misconfigured workflow.
2. If this runDate should be republished intentionally, delete
   `issues/<runDate>/.published` and re-run. This should be rare and
   deliberate.
3. If the sentinel is present but the Buttondown issue is missing, the
   archive and the remote have diverged — escalate manually.

### `empty_skip`

**Meaning.** After curation, fewer than `MIN_ITEMS_TO_PUBLISH` items were
marked `keep=true`. Reason code: `S-02`.

**Subscriber impact.** None — no empty issue was sent.

**Troubleshooting.**
1. Check the `curation complete` log line for `kept` vs `totalScored`. A
   kept count of 0–1 suggests a curator prompt drift.
2. Inspect a few of the dropped items via their source URLs — was the day
   genuinely low-signal or is the curator too conservative?
3. If operator-desired, lower `MIN_ITEMS_TO_PUBLISH` in the workflow env.
   Default is 5.

### `source_floor_skip`

**Meaning.** After pre-filter, unique contributing sources were below
`MIN_SOURCES`. Reason code: `S-05`.

**Subscriber impact.** None.

**Troubleshooting.**
1. Check `summary.<source>.status` in the job summary — one or more
   sources likely errored or timed out.
2. For `error` statuses, read the `error` field in the summary table. HTTP
   4xx/5xx from HN, Reddit, or RSS upstreams are the typical cause.
3. Confirm `MIN_SOURCES` (default 2) matches operator intent. In a
   partial-outage window it may be appropriate to relax to 1 temporarily.

### `failed` (`reason=missing_api_key`)

**Meaning.** `BUTTONDOWN_API_KEY` is not set. Checked **after** the
sentinel check so already-published runs do not require the key.

**Subscriber impact.** None.

**Troubleshooting.**
1. Confirm `BUTTONDOWN_API_KEY` is set in the repo's Actions Secrets.
2. Confirm the workflow references it as an env var on the run step.
3. If running locally, verify `.env` is loaded and the variable is
   non-empty.

### `failed` (`reason=fetch_failed`)

**Meaning.** `fetchAll` threw before returning a per-source summary — the
entire collection step blew up, which is different from an individual
collector erroring (those land as `status: "error"` rows in the summary).

**Subscriber impact.** None.

**Troubleshooting.**
1. Look for the `"fetchAll failed"` error line for the underlying cause.
2. Most likely cause is a bug in one of the collectors that escapes the
   per-source try/catch, or a parent abort before any collector started.
3. Re-run the workflow. If it fails again with the same error on a fresh
   run, open an issue with the stacktrace.

### `failed` (`reason=curator_failed`)

**Meaning.** The curator raised after exhausting retries (`Un-05`).
ClaudeCurator retries `maxRetries` times per chunk; if any chunk never
returns a complete record set, the whole run fails.

**Subscriber impact.** None.

**Troubleshooting.**
1. Search the log for `"curator chunk attempt failed"` — the last attempt
   message has the root cause (HTTP 529, schema-parse error, etc.).
2. For transient issues (529, 503, network) simply re-run the workflow.
3. For persistent schema failures (`CountInvariantError`), the prompt or
   the upstream model's output format has drifted — inspect
   `src/curator/prompt.ts` for PROMPT_VERSION and any mismatch.

### `failed` (`reason=E-05`)

**Meaning.** The curator returned a different item count than it was
given. This is the E-05 count invariant; it protects against silent item
loss.

**Subscriber impact.** None.

**Troubleshooting.**
1. Read `"curator count mismatch"` log line for `expected` vs `actual`.
2. This almost always means the upstream model dropped records. Check
   recent ClaudeCurator changes and re-run once.
3. If it repeats on a fresh run, the invariant has been broken by new code
   — roll back the curator change and reopen the issue.

### `failed` (`reason=Un-01`)

**Meaning.** Un-01 link-integrity gate fired: a URL in the scored output
does not appear in the raw input. The curator hallucinated a link, which
is a must-not-ship condition.

**Subscriber impact.** None.

**Troubleshooting.**
1. Read the `"Un-01 link-integrity violation"` log line; the `sample`
   field contains up to 5 offenders (`id`, `location`, offending URL).
2. Verify the renderer's template URLs are still whitelisted — the
   orchestrator intentionally passes an empty allowlist, so only
   ScoredItem URLs are checked. Template URLs that leaked into
   ScoredItem fields indicate a prompt drift.
3. If verified hallucination, do not bypass. Re-run; if it repeats,
   investigate the prompt or lower `relevanceScore` threshold.

### `failed` (`reason=publish_failed`)

**Meaning.** Publisher exhausted retries. Archive and rendered artifacts
are available in the orchestrator result but nothing was sent to
Buttondown.

**Subscriber impact.** None — no email was delivered.

**Troubleshooting.**
1. Read `"publish failed"` for `httpStatus` and `attempts`.
2. `401`/`403` → API key rotated. `4xx` other → payload shape changed.
   `5xx` / transient → retry workflow.
3. If the Buttondown status page shows an incident, wait and re-run. The
   sentinel was not written, so a later manual re-run will not duplicate.

## Weekly statuses (`WeeklyResult.status`)

### `published`

**Meaning.** Weekly digest sent and `weekly/<weekId>.published` sentinel
written.

**Subscriber impact.** Email sent successfully.

**Troubleshooting.** No action required.

### `published_sentinel_failed`

**Meaning.** Digest sent, but sentinel write failed. A subsequent weekly
cron for the same `weekId` **would re-send** without the sentinel; the
workflow exits 1 on purpose so the failure is visible before that next
run. The workflow's commit step should still have committed the digest
markdown.

**Subscriber impact.** Email sent.

**Troubleshooting.**
1. Find `"weekly sentinel write failed"` for the underlying fs error.
2. Manually create `weekly/<weekId>.published` (any content) and commit
   it before the next Monday cron fires, or the digest will re-send.
3. Investigate disk/permissions root cause on the runner.

### `dry_run`

**Meaning.** `DRY_RUN=1` set. Digest was built and written to
`weekly/<weekId>.md` but not sent.

**Subscriber impact.** None.

**Troubleshooting.** Inspect the digest path; nothing to fix.

### `no_days_available`

**Meaning.** The 7-day rollup window contained zero usable items.json
files. Almost always indicates upstream breakage in daily runs over the
preceding week.

**Subscriber impact.** None.

**Troubleshooting.**
1. Check `issues/<runDate>/` directories for the 7 days in the window —
   if empty or malformed items.json, the daily runs were failing.
2. Run `bd ready` to see any open daily-pipeline incidents.
3. This is usually a no-op — the weekly correctly refuses to send a
   blank digest. Fix the daily pipeline; the next weekly will pick up.

### `idempotent_skip`

**Meaning.** `weekly/<weekId>.published` sentinel already exists. Run
bailed before any fs reads or Buttondown POST.

**Subscriber impact.** None.

**Troubleshooting.** No action. If intentionally re-publishing, delete the
sentinel and re-run.

### `failed` (`reason=missing_api_key`)

**Meaning.** `BUTTONDOWN_API_KEY` not set in the weekly workflow env.

**Subscriber impact.** None.

**Troubleshooting.** Same as the daily case — confirm the secret is set
and referenced in `weekly.yml`.

### `failed` (`reason=publish_failed`)

**Meaning.** Publisher exhausted retries. The digest markdown was still
written to `weekly/<weekId>.md` for inspection; no sentinel was written.

**Subscriber impact.** None.

**Troubleshooting.**
1. Read `"weekly publish failed"` for `httpStatus`.
2. `4xx` → check API key / payload; `5xx` → retry.
3. Because there is no sentinel, a re-run after the incident clears will
   re-publish cleanly.

## Common fields in the job summary

| Field               | Where it comes from                             | Useful for              |
|---------------------|-------------------------------------------------|-------------------------|
| `runId`             | `makeRunId()` in `src/log.ts`                   | Grepping logs           |
| `curator cost`      | ClaudeCurator token counts × per-1M-tok price   | Budget tracking         |
| `redirect fails`    | `ctx.metrics.redirectFailures` (hn, reddit)     | Upstream URL health     |
| Per-source `Raw`    | Collector item count before pre-filter          | Freshness / volume trend|
| Per-source `Kept`   | Pre-filter survivors (E3)                       | Dedup / freshness health|
| Stage timings       | `stage(name, fn)` wrapper in orchestrator.ts    | Latency regressions     |

## When to open a new runbook entry

Add a section here whenever a new `OrchestratorStatus` or `WeeklyStatus`
value is introduced in code. The `runSummary.ts` tests assert these
statuses render without throwing; **this doc is the operator-facing
counterpart** and must be kept in sync with the union types in
`orchestrator.ts` and `weekly/index.ts`.
