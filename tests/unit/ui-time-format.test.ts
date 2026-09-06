/**
 * Issue #21 — time formatting utilities (PRD §27.8): timestamps persisted
 * UTC, displayed with an `Atlantic/Cape_Verde` default (UTC−1, no DST).
 * Pure functions — node environment, no DOM.
 */
import { describe, expect, it } from "vitest";
import { DISPLAY_TIMEZONE, formatRelative, formatTimestamp } from "../../src/lib/time-format";

describe("formatTimestamp (PRD §27.8)", () => {
  it("renders UTC input in the display timezone (Cape Verde = UTC−1)", () => {
    // 2026-09-06T00:07Z → 2026-09-05 23:07 in Atlantic/Cape_Verde.
    expect(formatTimestamp("2026-09-06T00:07:00.000Z")).toBe("2026-09-05 23:07");
  });

  it("supports an explicit timezone override (UTC itself)", () => {
    expect(formatTimestamp("2026-09-06T00:07:00.000Z", "UTC")).toBe("2026-09-06 00:07");
  });

  it("defaults to the §27.8 display timezone constant", () => {
    expect(DISPLAY_TIMEZONE).toBe("Atlantic/Cape_Verde");
  });

  it("fails loud on unparseable input", () => {
    expect(() => formatTimestamp("not-a-date")).toThrow(/unparseable/);
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-09-06T12:00:00.000Z");

  it("coarsens deltas: just now, minutes, hours, days", () => {
    expect(formatRelative("2026-09-06T11:59:30.000Z", now)).toBe("just now");
    expect(formatRelative("2026-09-06T11:55:00.000Z", now)).toBe("5m ago");
    expect(formatRelative("2026-09-06T09:30:00.000Z", now)).toBe("2h ago");
    expect(formatRelative("2026-09-04T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("treats future timestamps as just now (never negative)", () => {
    expect(formatRelative("2026-09-06T12:05:00.000Z", now)).toBe("just now");
  });

  it("fails loud on unparseable input", () => {
    expect(() => formatRelative("garbage", now)).toThrow(/unparseable/);
  });
});
