/**
 * Time helpers — UTC ISO-8601 with millisecond precision everywhere
 * (PRD §17 preamble: one consistent timestamp format, no mixing).
 */
export function nowIso(): string {
  return new Date().toISOString();
}
