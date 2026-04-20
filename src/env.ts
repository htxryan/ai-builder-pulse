// Shared env-parsing helpers. Consolidates `parsePositiveInt` /
// `parsePositiveNumber` logic that previously lived duplicated in
// `orchestrator.ts`, `curator/index.ts`, and `curator/deepagent/index.ts`.
//
// All helpers fail loudly on malformed values so an operator typo surfaces
// at parse time rather than producing a silent `NaN` mid-pipeline.

export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `Invalid env ${name}=${raw} (expected positive integer >= 1)`,
    );
  }
  return n;
}

export function parsePositiveNumber(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid env ${name}=${raw} (expected positive number > 0)`,
    );
  }
  return n;
}

export function parseBoolFlag(raw: string | undefined): boolean {
  // Match the rest of the codebase: "1" turns it on. Anything else is off.
  return raw === "1";
}
