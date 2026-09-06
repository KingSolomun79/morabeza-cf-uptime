/**
 * Issue #25 — display-timezone conversions (PRD §27.8): persisted UTC,
 * Atlantic/Cape_Verde wall-clock inputs (UTC−1, no DST). The issue's
 * acceptance case is the −1h offset; these tests pin it in both directions.
 */
import { describe, expect, it } from "vitest";
import { utcToWallInput, wallInputToUtcIso, wallInputToUtcMs } from "../../src/lib/datetime-local";

describe("utcToWallInput (UTC → Cape Verde wall)", () => {
  it("applies the §27.8 −1h offset: 12:00Z displays as 11:00", () => {
    expect(utcToWallInput("2026-09-05T12:00:00.000Z")).toBe("2026-09-05T11:00");
  });

  it("crosses midnight backwards: 00:30Z is 23:30 the previous day", () => {
    expect(utcToWallInput("2026-09-05T00:30:00.000Z")).toBe("2026-09-04T23:30");
  });

  it("honors an explicit timezone override (UTC stays UTC)", () => {
    expect(utcToWallInput("2026-09-05T12:00:00.000Z", "UTC")).toBe("2026-09-05T12:00");
  });

  it("throws (fail loud) on unparseable timestamps", () => {
    expect(() => utcToWallInput("not-a-date")).toThrow(/unparseable/);
  });
});

describe("wallInputToUtcIso (Cape Verde wall → UTC)", () => {
  it("applies the −1h offset and emits ms-precision UTC (the storage format)", () => {
    expect(wallInputToUtcIso("2026-09-05T11:00")).toBe("2026-09-05T12:00:00.000Z");
    expect(wallInputToUtcIso("2026-09-05T11:00")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("crosses midnight forwards: 23:30 wall is 00:30Z the next day", () => {
    expect(wallInputToUtcIso("2026-09-05T23:30")).toBe("2026-09-06T00:30:00.000Z");
  });

  it("is the exact inverse of utcToWallInput across a spread of instants", () => {
    for (const hour of [0, 5, 12, 18, 23]) {
      const iso = `2026-09-05T${String(hour).padStart(2, "0")}:15:00.000Z`;
      expect(wallInputToUtcIso(utcToWallInput(iso))).toBe(iso);
    }
  });

  it("returns null for malformed inputs (callers surface a field error)", () => {
    expect(wallInputToUtcIso("")).toBeNull();
    expect(wallInputToUtcIso("2026-09-05")).toBeNull();
    expect(wallInputToUtcIso("2026-09-05 11:00")).toBeNull();
    expect(wallInputToUtcIso("garbage")).toBeNull();
  });

  it("wallInputToUtcMs agrees with the ISO helper", () => {
    expect(wallInputToUtcMs("2026-09-05T11:00")).toBe(Date.parse("2026-09-05T12:00:00.000Z"));
  });
});
