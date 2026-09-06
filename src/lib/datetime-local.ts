/**
 * Datetime-local ↔ UTC conversion in the operator's display timezone
 * (issue #25; PRD §27.8): persisted timestamps stay ms-precision UTC, while
 * maintenance-window inputs render and accept wall-clock time in
 * `Atlantic/Cape_Verde` (§27.8 default, UTC−1, no DST). Pure functions so
 * the −1h offset cases are unit-testable without DOM.
 */
import { DISPLAY_TIMEZONE } from "./time-format";

const WALL_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function zoneParts(utcMs: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
  };
}

/** Offset (ms) to ADD to a UTC instant to get the wall clock in `timeZone`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const p = zoneParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC ISO → wall-clock value for a `<input type="datetime-local">`, in `timeZone`. */
export function utcToWallInput(iso: string, timeZone: string = DISPLAY_TIMEZONE): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`unparseable timestamp "${iso}"`);
  const p = zoneParts(ms, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(p.y)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/**
 * `<input type="datetime-local">` wall time in `timeZone` → UTC ms.
 * Two-pass offset resolution so DST zones also converge; invalid input
 * returns null (callers surface a field error).
 */
export function wallInputToUtcMs(wall: string, timeZone: string = DISPLAY_TIMEZONE): number | null {
  const match = WALL_INPUT_PATTERN.exec(wall);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const wallAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  if (Number.isNaN(wallAsUtc)) return null;
  let utc = wallAsUtc;
  for (let pass = 0; pass < 2; pass++) {
    utc = wallAsUtc - zoneOffsetMs(utc, timeZone);
  }
  return utc;
}

/** Wall input → ms-precision UTC ISO (the schema-enforced storage format). */
export function wallInputToUtcIso(wall: string, timeZone: string = DISPLAY_TIMEZONE): string | null {
  const ms = wallInputToUtcMs(wall, timeZone);
  return ms === null ? null : new Date(ms).toISOString();
}
