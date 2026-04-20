# AI Builder Pulse — Advisory Fleet Brief

**Prepared:** 2026-04-18
**Spec reviewed:** `docs/specs/ai-builder-pulse.md`
**Advisors consulted:** Claude Sonnet 4.6 (Security + Simplicity) · Gemini (Scalability + Organizational)
**Advisors unavailable:** Codex (not installed on machine)

---

## P0 Concerns

### P0-1 · Buttondown-based idempotency sentinel (C7) has a pagination failure
**Source:** Claude (Security).
**Detail:** S-03 / C7 rely on a LIST call to Buttondown to check whether today's subject-date sentinel already exists. After several months of issues, the API paginates. The sentinel may be on page N; the check returns false and publishes a duplicate.
**Suggestion:** Replace C7 with a local sentinel. Archivist writes `issues/YYYY-MM-DD/.published` atomically after a successful publish. On retry, Orchestrator checks this file before calling Publisher. No network roundtrip, no pagination, version-controlled audit trail. Removes C7 as a Composition-type contract.

### P0-2 · Un-06 (git-commit-after-publish failure) has no recovery requirement
**Source:** Claude (Security). *Related to Gemini's P1 (critical-path lens).*
**Detail:** Scenario 12 says "loud divergence alert," but the spec does not require recovery. Weekly digest (E-02) reads committed `items.json` files; a missing day silently rolls up 6 days with no signal.
**Suggestion:** Add a recovery requirement: "On the run following an Un-06 alert, the Orchestrator SHALL detect the missing archive and attempt backfill before proceeding with the current day." Also make E-02 tolerant to missing days (count available vs hardcoded 7) and annotate the digest when a day is absent.

### P0-3 · Git repo size unbounded over 5+ year horizon
**Source:** Gemini (Scalability).
**Detail:** At steady-state (v1 volume) this is a non-issue. But the spec treats `issues/` as irreversible and unbounded. At 100x scale or multi-year accumulation, GHA checkouts slow and `.git` bloats.
**Suggestion:** Add optional rolling-archive policy: minify `items.json` before commit, and (future) migrate files older than N days to a separate `history` branch or cold storage. Not a v1 blocker — but acknowledge the growth plan in the spec so C6 is not prematurely "irreversible."

### P0-4 · "Message Batches API" vs synchronous `messages.create` is ambiguous (O-04)
**Source:** Gemini (Organizational).
**Detail:** O-04 says the system MAY substitute Message Batches for synchronous calls, schema unchanged. But Batches has a 24h SLA — the pipeline would need a two-phase design (submit → exit → wake up → fetch → publish). That is a completely different Orchestrator shape for a solo maintainer.
**Suggestion:** Clarify O-04: v1 uses **synchronous** `messages.create`. Message Batches is deferred to v2 explicitly, and adopting it will require re-architecting the Orchestrator into two GHA runs. Remove from the v1 scope or clearly fence it.

---

## P1 Concerns

### P1-1 · Epic count too granular for solo maintainer
**Source:** Gemini (Organizational) + Claude (Simplicity) — **consensus**.
**Detail:**
- Gemini: Epics 2, 3, 4, 5 (collectors) are functionally identical adapters; collapse into one "Ingestion Engines" epic.
- Claude: 8 contracts → 5 epics. Archivist, Link-integrity, and Pre-filter are modules, not bounded contexts. For ~500 lines of TypeScript, microservice-granularity epics add ceremony without isolating real complexity.
**Suggestion:** Target ~6-7 materialized epics: (1) Foundation + Orchestration + Scheduling, (2) Ingestion (all collectors + the C1 interface), (3) Pre-filter (if kept separate) OR fold into Ingestion, (4) Curation + Link-integrity (linked invariant lives with the thing whose output it checks), (5) Rendering + Publishing (Buttondown adapter + idempotency sentinel + empty-issue guard), (6) Persistence + Weekly Digest, (7) Integration Verification. Reassess per-epic cognitive load at synthesis.

### P1-2 · E-05 item-count semantics underspecified
**Source:** Claude (Security).
**Detail:** "Claude returns item count ≠ input count → reject and fail" is ambiguous because U-02's ScoredItem includes `keep: boolean`. Two implementations diverge: "return all input with keep flag" vs "return only kept items." Under the second reading, E-05 would always fire and break nominal runs.
**Suggestion:** Make Curator contract explicit: "Claude MUST return exactly one ScoredItem per RawItem provided, in any order, with `keep: true|false`. The E-05 invariant is `scoredItems.length === rawItemsSentToClaude.length`." Add to the spec.

### P1-3 · Un-01 must exclude template-static URLs explicitly
**Source:** Claude (Security).
**Detail:** Link-integrity will fail on every run if the Renderer emits an unsubscribe footer, website link, or Buttondown-hosted archive link — none of which are in the RawItem set.
**Suggestion:** Scope Un-01 to `ScoredItem.url` and URLs extracted from `ScoredItem.description` only. Template-static URLs live in a named allowlist owned by the Renderer.

### P1-4 · runDate needs a single source of truth
**Source:** Claude (Security).
**Detail:** The archive path, the publish sentinel, and the 24h freshness window each derive "today" independently. A cron starting at 23:58 UTC and ending at 00:03 UTC can archive to date D but check the sentinel for D+1.
**Suggestion:** Extend C8: the Orchestrator derives a single `runDate: YYYY-MM-DD` (UTC) at process startup and passes it as immutable context to every stage. Add `runDate` to the C8 contract.

### P1-5 · Partial-collector-failure floor is undefined
**Source:** Claude (Security).
**Detail:** S-04 handles Reddit missing; there is no minimum viable source count. If three of four collectors fail silently, the pipeline publishes a thin issue with no indication of data completeness.
**Suggestion:** Add invariant: "If fewer than `N` collectors return items (recommended N=2), treat as unrecoverable (E-04) instead of publishing. Include per-source success/failure as `sourceSummary` in committed `items.json`."

### P1-6 · Un-04 (secret leakage) has no named detection mechanism
**Source:** Claude (Security).
**Detail:** The outcome is specified; the mechanism is not. `metadata: Record<string, unknown>` in U-01 is an open channel for secret tokens accidentally echoed by source APIs.
**Suggestion:** (a) Bound U-01 `metadata` to a closed Zod schema with named fields per source. (b) Name a secret-scan tool (`gitleaks` or `trufflehog`) in the workflow YAML between Archivist and push.

### P1-7 · Curator needs a chunk-and-merge fallback
**Source:** Gemini (Scalability).
**Detail:** A single batched Claude call hits output-token limits when ~100+ items surface. Truncated JSON triggers E-05 and stalls the pipeline.
**Suggestion:** Curator supports "map-reduce" mode: chunk pre-filtered items into batches of ~50 and run parallel curation calls when the pre-filter count exceeds a configurable threshold. Schema unchanged; merge results keyed by RawItem id.

### P1-8 · Per-collector timeouts are not a contract requirement
**Source:** Gemini (Scalability).
**Detail:** C1 says "timeout ≤60s per collector" in the notes column, but the spec does not require the Orchestrator to enforce it or recover from a slow source.
**Suggestion:** Promote per-collector timeout to a behavioral element of C1. Define fallback: if one collector exceeds its timeout, the Orchestrator proceeds with partial results as long as P1-5's floor is satisfied.

---

## P2 Concerns

### P2-1 · Redirect-chain URLs pass link-integrity but may not be canonical
**Source:** Claude (Security).
**Suggestion:** Collectors follow ≤3 redirect hops before constructing RawItem; `url = final URL`, `metadata.sourceUrl = original`. Dedup (U-04) and link-integrity (Un-01) operate on canonical URLs.

### P2-2 · DRY_RUN interaction with idempotency check is unspecified
**Source:** Claude (Security).
**Suggestion:** DRY_RUN bypasses the S-03 idempotency check. Log `[DRY_RUN] would publish`. Skip Buttondown POST and git commit.

### P2-3 · Critical path feels long — "no visible pulse" until Curator works
**Source:** Gemini (Organizational).
**Suggestion:** Introduce a Mock Curator (pass-through that fabricates scores) in Foundation so Rendering/Publishing/Archiving can be wired and verified end-to-end with static data before Claude integration lands.

### P2-4 · Weekly digest irreversibility premature
**Source:** Claude (Simplicity).
**Suggestion:** Either commit Weekly Digest to v1 (making C6's irreversibility load-bearing) or relax the label to "chosen for simplicity; Weekly Digest is a v1.x consumer."

---

## Strengths (Consensus)

- **Link-integrity placement between Curator and Publisher is the right trust boundary** — Claude cannot fabricate URLs that reach subscribers regardless of what it returns. *(Claude)*
- **Zod at every inter-stage boundary** makes schema drift a runtime error, not a silent mismatch. *(Both)*
- **Single batched Claude call** is the right simplicity and cost choice for v1. *(Claude — Simplicity strength)*
- **Collector interface (C1)** is the one genuine plug-in boundary; adding a new source is the realistic evolution. *(Claude)*
- **Pre-filter before Claude** is the single best cost-control measure. *(Gemini)*
- **Twitter/X deferred to v2 with env flag** is clean YAGNI. *(Claude)*
- **GitHub Actions + keepalive (E-03)** avoids a real operational hazard. *(Claude)*
- **Weekly rollup reuses `items.json`** — the weekly digest is a free byproduct. *(Gemini)*
- **DRY_RUN** removes need for a staging Buttondown account. *(Claude)*

---

## Alternative Approaches Suggested

1. **Local `.published` sentinel replaces C7 LIST call** (Claude). Eliminates a cross-epic Composition contract and a production API dependency.
2. **Merge link-integrity + pre-filter into sibling modules rather than separate epics** (Claude). Keeps the invariant but removes epic ceremony.
3. **Mock Curator in Foundation** (Gemini). Unblocks downstream-stage development before Claude integration is ready.
4. **Per-epic, per-source sourceSummary in committed items.json** (Claude). Adds observability without adding a new external sink.

---

## Confidence Summary

| Advisor lens | Confidence | Justification |
|---|---|---|
| Security & Reliability | **MEDIUM** | Core trust contract (no URL fabrication) is well-designed and correctly placed. However, P0/P1 items (Un-06 recovery, C7 pagination, Un-04 detection mechanism) are underspecified enough that implementers would make independent decisions that may not compose under real failure conditions. |
| Simplicity & Alternatives | **MEDIUM** (devil's-advocate: moderate case, not slam-dunk) | Spec is not egregiously over-engineered; most complexity is justified. Strongest simplification targets are C7 (local sentinel) and demoting Archivist/Link-integrity/Pre-filter from epic to module. Collapsing 8 contracts to ~5 epics would reduce planning overhead without losing testability. |
| Scalability & Performance | **HIGH** | Batch-pipeline-on-cron shape fits GHA perfectly. Long-term risks are Git bloat (5+ years) and LLM output limits at 100x. Neither is a v1 blocker; both deserve explicit acknowledgement in the spec. |
| Organizational & Delivery | **MEDIUM** | Logic is sound. The 13-candidate-epic decomposition is too granular for a solo maintainer. Ambiguity between sync Claude and Message Batches API could cause mid-flight pivot. |

---

## Recommended Spec Revisions Before Phase 3

These are the revisions I will apply to `docs/specs/ai-builder-pulse.md` if the user approves at Gate 2. Each maps to an advisor concern above.

| # | Revision | Resolves |
|---|---|---|
| R1 | Replace C7 description: "Publisher idempotency check is a local `issues/{runDate}/.published` sentinel file written in the same commit as issue.md; Buttondown LIST is NOT used." Demote C7 from Composition to Data. | P0-1, P2-2, P1 simplification |
| R2 | Add recovery requirement: "On the run following an Un-06 alert, the Orchestrator SHALL detect the missing archive and attempt backfill." E-02 counts available days, not hardcoded 7. | P0-2 |
| R3 | Clarify O-04: v1 uses synchronous `messages.create` only. Message Batches deferred to v2 with explicit re-architecture note. | P0-4 |
| R4 | Make E-05 explicit: "Claude returns exactly one ScoredItem per RawItem provided; the invariant is `scoredItems.length === rawItemsSentToClaude.length`." | P1-2 |
| R5 | Scope Un-01: "applies to URLs extracted from `ScoredItem.url` and `ScoredItem.description` only. Renderer-owned allowlist governs template-static URLs." | P1-3 |
| R6 | Extend C8 with immutable `runDate: YYYY-MM-DD` (UTC) derived once at Orchestrator startup and passed to every stage. | P1-4 |
| R7 | Add invariant: "If fewer than N=2 collectors return items, treat as E-04; record `sourceSummary` in committed `items.json`." | P1-5 |
| R8 | Bound U-01 `metadata` to closed Zod schema with per-source named fields. Add `gitleaks` (or `trufflehog`) scan step in workflow YAML. | P1-6 |
| R9 | Add Curator chunk-merge fallback (O-07 optional): "If pre-filtered count exceeds `CURATOR_CHUNK_THRESHOLD`, chunk into parallel calls and merge by RawItem id. Schema unchanged." | P1-7 |
| R10 | Promote per-collector timeout to explicit C1 behavior: "Each collector SHALL enforce a configurable timeout (default 60s). Orchestrator proceeds with partial results if R7's floor is satisfied." | P1-8 |
| R11 | Collectors follow ≤3 redirect hops; canonical URL goes to `url`, original to `metadata.sourceUrl`. | P2-1 |
| R12 | Relax C6 "(irreversible)" → "chosen for simplicity; Weekly Digest consumer documented; future rolling-archive policy optional." Note v1 retention policy in the spec. | P0-3, P2-4 |
| R13 | Phase 3 decomposition uses the **6-7 epic target**: Foundation+Orchestration, Ingestion (all collectors), Curation+Link-integrity, Rendering+Publishing, Persistence+Weekly-Digest, Integration Verification. Evaluate whether Pre-filter stands alone or folds into Ingestion during synthesis. | P1-1, P2-3 |
| R14 | Foundation epic delivers a **Mock Curator** pass-through so downstream stages are testable before Claude integration lands. | P2-3 |

---
*Next: present brief + revision list at Gate 2 via AskUserQuestion.*
