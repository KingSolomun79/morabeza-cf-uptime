/**
 * Structured logging (PRD §28): one JSON object per line with stable field
 * names. Never log Access JWTs, cookies, response bodies, or secret headers.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logEvent(event: string, fields: LogFields = {}): void {
  const entry: Record<string, unknown> = { event, ts: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) entry[key] = value;
  }
  console.log(JSON.stringify(entry));
}
