// Node loader hook that records every resolved specifier to a file.
//
// Loaders run in a worker thread, so in-memory state is not directly
// observable from the main thread. We write specifiers to the path given
// in env LOADER_RECORD_PATH — the probe reads that file at the end.

import { appendFileSync } from "node:fs";

const RECORD_PATH = process.env.LOADER_RECORD_PATH;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (RECORD_PATH) {
    try {
      appendFileSync(RECORD_PATH, (result.url ?? specifier) + "\n");
    } catch {
      // swallow — the test will report an empty/missing file
    }
  }
  return result;
}
