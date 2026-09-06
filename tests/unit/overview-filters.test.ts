/**
 * Issue #22 — Overview table filter + pagination logic (PRD §27.3).
 * Pure functions, node environment.
 */
import { describe, expect, it } from "vitest";
import { distinctClients, filterMonitorRows, paginate } from "../../src/pages/overview-filters";
import type { DashboardMonitorRow } from "../../src/types/dashboard";

function row(overrides: Partial<DashboardMonitorRow>): DashboardMonitorRow {
  return {
    id: "mon_x",
    clientId: "cli_a",
    clientName: "Alpha",
    name: "Alpha Homepage",
    status: "up",
    inMaintenance: false,
    uptime24h: { status: "ok", percentage: 100, eligibleChecks: 10 },
    lastResponseTimeMs: 100,
    lastCheckedAt: "2026-09-06T12:00:00.000Z",
    openIncidentId: null,
    ...overrides,
  };
}

const ROWS: DashboardMonitorRow[] = [
  row({ id: "mon_1", clientId: "cli_a", clientName: "Alpha", name: "Alpha Homepage", status: "up" }),
  row({ id: "mon_2", clientId: "cli_a", clientName: "Alpha", name: "Alpha API", status: "down" }),
  row({ id: "mon_3", clientId: "cli_b", clientName: "Beta", name: "Beta Portal", status: "down", inMaintenance: true }),
  row({ id: "mon_4", clientId: "cli_b", clientName: "Beta", name: "Beta New", status: "unknown" }),
  row({ id: "mon_5", clientId: "cli_b", clientName: "Beta", name: "Beta Paused", status: "paused" }),
];

describe("filterMonitorRows (PRD §27.3 filters)", () => {
  it("passes everything through with empty filters", () => {
    expect(filterMonitorRows(ROWS, { clientId: null, status: null, query: "" })).toHaveLength(5);
  });

  it("filters by client", () => {
    const result = filterMonitorRows(ROWS, { clientId: "cli_b", status: null, query: "" });
    expect(result.map((r) => r.id)).toEqual(["mon_3", "mon_4", "mon_5"]);
  });

  it("filters by status", () => {
    const result = filterMonitorRows(ROWS, { clientId: null, status: "down", query: "" });
    expect(result.map((r) => r.id)).toEqual(["mon_2", "mon_3"]);
  });

  it("filters by the maintenance sentinel (display overlay state)", () => {
    const result = filterMonitorRows(ROWS, { clientId: null, status: "maintenance", query: "" });
    expect(result.map((r) => r.id)).toEqual(["mon_3"]);
  });

  it("matches text search case-insensitively across monitor and client names", () => {
    expect(filterMonitorRows(ROWS, { clientId: null, status: null, query: "beta portal" }).map((r) => r.id)).toEqual(["mon_3"]);
    expect(filterMonitorRows(ROWS, { clientId: null, status: null, query: "ALPHA" }).map((r) => r.id)).toEqual(["mon_1", "mon_2"]);
  });

  it("combines client + status + search", () => {
    expect(filterMonitorRows(ROWS, { clientId: "cli_b", status: "down", query: "portal" }).map((r) => r.id)).toEqual(["mon_3"]);
    // Combination that matches nothing.
    expect(filterMonitorRows(ROWS, { clientId: "cli_a", status: "down", query: "portal" })).toEqual([]);
  });
});

describe("paginate", () => {
  it("slices pages and clamps out-of-range pages", () => {
    const first = paginate(ROWS, 1, 2);
    expect(first.rows.map((r) => r.id)).toEqual(["mon_1", "mon_2"]);
    expect(first).toMatchObject({ total: 5, pageCount: 3, page: 1 });

    const clamped = paginate(ROWS, 99, 2);
    expect(clamped.page).toBe(3);
    expect(clamped.rows.map((r) => r.id)).toEqual(["mon_5"]);
  });

  it("yields one (empty) page for no rows", () => {
    const page = paginate([], 1, 10);
    expect(page).toEqual({ rows: [], total: 0, pageCount: 1, page: 1 });
  });
});

describe("distinctClients", () => {
  it("dedupes clients preserving first-seen order", () => {
    expect(distinctClients(ROWS)).toEqual([
      { id: "cli_a", name: "Alpha" },
      { id: "cli_b", name: "Beta" },
    ]);
  });
});
