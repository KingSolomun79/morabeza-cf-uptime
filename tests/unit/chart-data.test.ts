/**
 * Issue #24 — chart data shaping (PRD §27.5): checks → response-time
 * points, maintenance windows → overlay regions under the §14.2 scope
 * rules. Pure functions, node environment.
 */
import { describe, expect, it } from "vitest";
import { checksToChartPoints, maintenanceOverlaysForChart, overlayRegionsForPoints } from "../../src/lib/chart-data";
import type { CheckDto, MaintenanceWindowDto } from "../../src/types/monitor-detail";

function check(completedAt: string, responseTimeMs: number | null): CheckDto {
  return {
    id: `chk_${completedAt}`,
    monitorId: "mon_1",
    source: "scheduled",
    completedAt,
    isHealthy: true,
    maintenanceExcluded: false,
    statusCode: 200,
    responseTimeMs,
    reasonCode: "ok",
    errorMessage: null,
  };
}

function window(patch: Partial<MaintenanceWindowDto>): MaintenanceWindowDto {
  return {
    id: "mw_1",
    title: "Deploy",
    description: null,
    scopeType: "global",
    scopeId: null,
    startsAt: "2026-09-05T10:00:00.000Z",
    endsAt: "2026-09-05T11:00:00.000Z",
    createdBy: null,
    createdAt: "2026-09-05T09:00:00.000Z",
    updatedAt: "2026-09-05T09:00:00.000Z",
    cancelledAt: null,
    ...patch,
  };
}

describe("checksToChartPoints", () => {
  it("drops checks without a response time and sorts oldest→newest for the line", () => {
    const points = checksToChartPoints(
      [
        check("2026-09-05T10:10:00.000Z", 130),
        check("2026-09-05T10:00:00.000Z", 110),
        check("2026-09-05T10:05:00.000Z", null), // maintenance skip — no timing
        check("2026-09-05T10:15:00.000Z", 150),
      ],
      (iso) => `L:${iso}`,
    );
    expect(points.map((point) => point.ms)).toEqual([110, 130, 150]);
    expect(points.map((point) => point.label)).toEqual([
      "L:2026-09-05T10:00:00.000Z",
      "L:2026-09-05T10:10:00.000Z",
      "L:2026-09-05T10:15:00.000Z",
    ]);
  });

  it("yields an empty list when nothing has a response time", () => {
    expect(checksToChartPoints([check("2026-09-05T10:00:00.000Z", null)], String)).toEqual([]);
  });
});

describe("maintenanceOverlaysForChart (§14.2 scope + [start,end) overlap)", () => {
  const monitor = { id: "mon_1", clientId: "cli_1" };
  const range = { start: "2026-09-05T09:30:00.000Z", end: "2026-09-05T11:30:00.000Z" };

  it("matches global, same-client, and same-monitor windows; skips others", () => {
    const overlays = maintenanceOverlaysForChart(
      [
        window({ id: "mw_global" }),
        window({ id: "mw_client", scopeType: "client", scopeId: "cli_1" }),
        window({ id: "mw_monitor", scopeType: "monitor", scopeId: "mon_1" }),
        window({ id: "mw_other_client", scopeType: "client", scopeId: "cli_2" }),
        window({ id: "mw_other_monitor", scopeType: "monitor", scopeId: "mon_2" }),
      ],
      monitor,
      range,
    );
    expect(overlays.map((overlay) => overlay.id)).toEqual(["mw_global", "mw_client", "mw_monitor"]);
  });

  it("never includes cancelled windows", () => {
    const overlays = maintenanceOverlaysForChart(
      [window({ cancelledAt: "2026-09-05T09:00:00.000Z" })],
      monitor,
      range,
    );
    expect(overlays).toEqual([]);
  });

  it("applies half-open overlap: touching-but-not-overlapping windows are excluded", () => {
    const overlays = maintenanceOverlaysForChart(
      [
        window({ id: "mw_ends_exactly_at_range_start", endsAt: range.start }),
        window({ id: "mw_starts_exactly_at_range_end", startsAt: range.end, endsAt: "2026-09-05T12:30:00.000Z" }),
        window({ id: "mw_overlaps", startsAt: "2026-09-05T09:00:00.000Z", endsAt: "2026-09-05T09:45:00.000Z" }),
      ],
      monitor,
      range,
    );
    expect(overlays.map((overlay) => overlay.id)).toEqual(["mw_overlaps"]);
  });

  it("sorts overlays by start time for stable chart stacking", () => {
    const overlays = maintenanceOverlaysForChart(
      [
        window({ id: "mw_late", startsAt: "2026-09-05T11:00:00.000Z", endsAt: "2026-09-05T11:30:00.000Z" }),
        window({ id: "mw_early", startsAt: "2026-09-05T09:00:00.000Z", endsAt: "2026-09-05T09:45:00.000Z" }),
      ],
      monitor,
      range,
    );
    expect(overlays.map((overlay) => overlay.id)).toEqual(["mw_early", "mw_late"]);
  });
});

describe("overlayRegionsForPoints (category-axis bracketing)", () => {
  const points = checksToChartPoints(
    [
      check("2026-09-05T10:00:00.000Z", 100),
      check("2026-09-05T10:05:00.000Z", 110),
      check("2026-09-05T10:10:00.000Z", 120),
      check("2026-09-05T10:15:00.000Z", 130),
    ],
    (iso) => iso,
  );

  it("brackets a window that contains NO plotted points (all its checks were excluded)", () => {
    // The gap between 10:05 and 10:10 holds zero plotted points.
    const regions = overlayRegionsForPoints(
      [{ id: "mw_gap", title: "Deploy", startsAt: "2026-09-05T10:05:10.000Z", endsAt: "2026-09-05T10:09:50.000Z" }],
      points,
    );
    expect(regions).toEqual([{ id: "mw_gap", title: "Deploy", x1: "2026-09-05T10:05:00.000Z", x2: "2026-09-05T10:10:00.000Z" }]);
  });

  it("uses surrounding points for a window with plotted points inside", () => {
    const regions = overlayRegionsForPoints(
      [{ id: "mw_mid", title: "Deploy", startsAt: "2026-09-05T10:04:00.000Z", endsAt: "2026-09-05T10:06:00.000Z" }],
      points,
    );
    expect(regions[0].x1).toBe("2026-09-05T10:00:00.000Z");
    expect(regions[0].x2).toBe("2026-09-05T10:10:00.000Z");
  });

  it("clamps windows that extend beyond the plotted range", () => {
    const regions = overlayRegionsForPoints(
      [{ id: "mw_wide", title: "Deploy", startsAt: "2026-09-05T09:00:00.000Z", endsAt: "2026-09-05T12:00:00.000Z" }],
      points,
    );
    expect(regions[0].x1).toBe(points[0].label);
    expect(regions[0].x2).toBe(points[points.length - 1].label);
  });

  it("yields no regions without points", () => {
    expect(overlayRegionsForPoints([{ id: "mw", title: "t", startsAt: "2026-09-05T10:00:00.000Z", endsAt: "2026-09-05T11:00:00.000Z" }], [])).toEqual([]);
  });
});
