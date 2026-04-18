const RUN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function deriveRunDate(now: Date = new Date()): string {
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  if (!RUN_DATE_RE.test(date)) {
    throw new Error(`Invalid runDate derived from ${iso}`);
  }
  return date;
}

export function isValidRunDate(s: string): boolean {
  return RUN_DATE_RE.test(s);
}

export function runDateMinusHours(runDate: string, hours: number): Date {
  if (!RUN_DATE_RE.test(runDate)) {
    throw new Error(`Invalid runDate: ${runDate}`);
  }
  const midnightUtc = new Date(`${runDate}T00:00:00.000Z`);
  return new Date(midnightUtc.getTime() - hours * 3600_000);
}
