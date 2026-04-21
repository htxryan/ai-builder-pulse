// One-shot archive regeneration for a runDate that already published
// externally but whose archive commit was lost (e.g. post-publish
// gitleaks failure blocked the push).
//
// Runs the orchestrator against a fake Publisher that returns a caller-
// supplied publishId instead of hitting Buttondown. The pipeline still
// collects, curates, and renders for real, so the archive content
// closely matches what was actually sent.
//
// NOT a fixup tool for byte-exact reconstruction — the curator is
// non-deterministic and the items will drift from the email. Use when
// "close enough for the web archive" is acceptable.
//
// Usage:
//   pnpm tsx scripts/archive-local.ts <publishId>

import { runOrchestrator } from "../src/orchestrator.js";
import type { Publisher, PublishOutcome } from "../src/orchestrator.js";
import type { RenderedIssue } from "../src/renderer/index.js";

const publishId = process.argv[2];
if (!publishId) {
  console.error("usage: pnpm tsx scripts/archive-local.ts <publishId>");
  process.exit(1);
}

const fakePublisher: Publisher = {
  async publish(_rendered: RenderedIssue): Promise<PublishOutcome> {
    return { id: publishId, attempts: 1 };
  },
};

const result = await runOrchestrator({
  now: new Date(),
  repoRoot: process.cwd(),
  env: process.env,
  publisher: fakePublisher,
});

console.log(JSON.stringify({ status: result.status, reason: result.reason }));
