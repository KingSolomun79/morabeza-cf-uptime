/**
 * Shared time formatting (issue #21; PRD §17 preamble + §27.8): timestamps
 * are persisted UTC (ms-precision ISO-8601) and rendered in the operator's
 * display timezone — defaulting to `Atlantic/Cape_Verde` per §27.8.
 */

/** §27.8 default display timezone (UTC−1, no DST). */
export const DISPLAY_TIMEZONE = "Atlantic/Cape_Verde";

function partsInZone(date: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

/** Parses a persisted UTC ISO timestamp; throws (fail loud) when invalid. */
function parseIso(iso: string): Date {
  const date = new Date(iso);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    throw new Error(`unparseable timestamp "${iso}"`);
  }
  return date;
}

/** Deterministic `YYYY-MM-DD HH:mm` in the display timezone. */
export function formatTimestamp(iso: string, timeZone: string = DISPLAY_TIMEZONE): string {
  const parts = partsInZone(parseIso(iso), timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Coarse relative time ("just now", "5m ago", "3h ago", "2d ago"). */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const deltaMs = now.getTime() - parseIso(iso).getTime();
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
