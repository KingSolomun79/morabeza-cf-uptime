/**
 * Issue #24 — monitor-scoped detail endpoints (PRD §24, §27.5):
 * GET /api/monitors/:id/checks (paginated history, documented minimal §24
 * extension) and GET /api/monitors/:id/incidents (open-first, scoped).
 * Against real D1 (miniflare) with explicit check/incident fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeTestDb, createTestDb, LOCAL_ORIGIN, type TestD1 } from "../helpers/d1";
import app from "../../worker/app";
import { getDb } from "../../worker/lib/db";
import { checkResults, incidents, monitorState, monitors } from "../../db/schema";
import type { Env } from "../../worker/env";

const NOW = "2026-09-05T12:00:00.000Z";

let testDb: TestD1;
let env: Env;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Origin: LOCAL_ORIGIN, ...(init.headers ?? {}) },
  }, { ...testDb.env } as Env);
}

interface CheckFixture {
  id: string;
  monitorId?: string;
  minutesAgo?: number;
  isHealthy?: boolean;
  source?: "scheduled" | "manual";
  maintenanceExcluded?: boolean;
  statusCode?: number | null;
  responseTimeMs?: number | null;
  reasonCode?: string;
}

function checkRow(fixture: CheckFixture) {
  const completedAt = new Date(Date.parse(NOW) - (fixture.minutesAgo ?? 0) * 60_000).toISOString();
  return {
    id: fixture.id,
    monitorId: fixture.monitorId ?? "mon_hist",
    source: fixture.source ?? "scheduled",
    scheduledFor: completedAt,
    startedAt: completedAt,
    completedAt,
    isHealthy: fixture.isHealthy === false ? 0 : 1,
    maintenanceExcluded: fixture.maintenanceExcluded === true ? 1 : 0,
    affectsState: fixture.maintenanceExcluded === true || fixture.source === "manual" ? 0 : 1,
    statusCode: fixture.statusCode === undefined ? 200 : fixture.statusCode,
    responseTimeMs: fixture.responseTimeMs === undefined ? 120 : fixture.responseTimeMs,
    reasonCode: fixture.reasonCode ?? (fixture.isHealthy === false ? "unexpected_status" : "ok"),
    createdAt: completedAt,
  };
}

beforeAll(async () => {
  testDb = await createTestDb();
  env = testDb.env;
  const db = getDb(env);

  const monitor = {
    id: "mon_hist",
    clientId: "cli_morabeza",
    name: "History Fixture",
    url: "https://hist.example.com/",
    nextCheckAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await db.insert(monitors).values(monitor);
  await db.insert(monitors).values({ ...monitor, id: "mon_other", name: "Other Fixture", url: "https://other.example.com/" });
  await db.insert(monitorState).values({ monitorId: "mon_hist", status: "up", consecutiveSuccesses: 3, stateVersion: 1, updatedAt: NOW });
  await db.insert(monitorState).values({ monitorId: "mon_other", status: "unknown", stateVersion: 1, updatedAt: NOW });

  // 7 checks, descending by completedAt: manual + maintenance rows included
  // so the detail table can show the scheduled/manual and maintenance flags.
  const rows = [
    checkRow({ id: "chk_1", minutesAgo: 5, responseTimeMs: 110 }),
    checkRow({ id: "chk_2", minutesAgo: 10, responseTimeMs: 130 }),
    checkRow({ id: "chk_3", minutesAgo: 15, isHealthy: false, statusCode: 503, responseTimeMs: 900, reasonCode: "unexpected_status" }),
    checkRow({ id: "chk_4", minutesAgo: 20, source: "manual", responseTimeMs: 140 }),
    checkRow({ id: "chk_5", minutesAgo: 25, maintenanceExcluded: true, isHealthy: false, statusCode: null, responseTimeMs: null, reasonCode: "maintenance_skip" }),
    checkRow({ id: "chk_6", minutesAgo: 30, responseTimeMs: 150 }),
    checkRow({ id: "chk_7", monitorId: "mon_other", minutesAgo: 1, responseTimeMs: 999 }),
  ];
  for (const row of rows) {
    await db.insert(checkResults).values(row);
  }

  await db.insert(incidents).values([
    { id: "inc_open_h", monitorId: "mon_hist", status: "open", openedAt: "2026-09-05T10:00:00.000Z", firstFailureAt: "2026-09-05T09:58:00.000Z", createdAt: NOW, updatedAt: NOW },
    { id: "inc_resolved_h", monitorId: "mon_hist", status: "resolved", openedAt: "2026-09-04T10:00:00.000Z", firstFailureAt: "2026-09-04T09:58:00.000Z", resolvedAt: "2026-09-04T11:00:00.000Z", resolutionReason: "recovered", outageDurationMs: 3_600_000, createdAt: NOW, updatedAt: NOW },
    { id: "inc_open_o", monitorId: "mon_other", status: "open", openedAt: "2026-09-05T11:00:00.000Z", firstFailureAt: "2026-09-05T10:55:00.000Z", createdAt: NOW, updatedAt: NOW },
  ]);
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("GET /api/monitors/:id/checks (#24)", () => {
  it("returns the monitor's checks newest-first with envelope pagination and booleans decoded", async () => {
    const response = await request("/api/monitors/mon_hist/checks");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: Array<Record<string, unknown>>;
      pagination: { total: number; limit: number; offset: number };
    };
    expect(payload.data).toHaveLength(6);
    expect(payload.pagination).toEqual({ total: 6, limit: 50, offset: 0 });
    // Newest first; the other monitor's row never leaks in.
    expect(payload.data[0].id).toBe("chk_1");
    expect(payload.data.map((row) => row.id)).not.toContain("chk_7");

    const maintenanceRow = payload.data.find((row) => row.id === "chk_5")!;
    expect(maintenanceRow.maintenanceExcluded).toBe(true);
    expect(maintenanceRow.statusCode).toBeNull();
    expect(maintenanceRow.responseTimeMs).toBeNull();
    const manualRow = payload.data.find((row) => row.id === "chk_4")!;
    expect(manualRow.source).toBe("manual");
    const failedRow = payload.data.find((row) => row.id === "chk_3")!;
    expect(failedRow.isHealthy).toBe(false);
    expect(failedRow.reasonCode).toBe("unexpected_status");
  });

  it("paginates with limit/offset and a stable newest-first order", async () => {
    const page1 = await request("/api/monitors/mon_hist/checks?limit=4&offset=0");
    const page2 = await request("/api/monitors/mon_hist/checks?limit=4&offset=4");
    const body1 = (await page1.json()) as { data: Array<{ id: string }>; pagination: { total: number } };
    const body2 = (await page2.json()) as { data: Array<{ id: string }>; pagination: { total: number } };
    expect(body1.data.map((row) => row.id)).toEqual(["chk_1", "chk_2", "chk_3", "chk_4"]);
    expect(body2.data.map((row) => row.id)).toEqual(["chk_5", "chk_6"]);
    expect(body2.pagination.total).toBe(6);
  });

  it("404s with the §38 envelope for an unknown monitor", async () => {
    const response = await request("/api/monitors/mon_nope/checks");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { category: string } };
    expect(body.error.category).toBe("not_found");
  });

  it("rejects out-of-range pagination params (§38 validation)", async () => {
    const response = await request("/api/monitors/mon_hist/checks?limit=500");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { category: string } };
    expect(body.error.category).toBe("validation");
  });
});

describe("GET /api/monitors/:id/incidents (#24)", () => {
  it("scopes incidents to the monitor, open first, with pagination", async () => {
    const response = await request("/api/monitors/mon_hist/incidents");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id: string; status: string; monitorId: string }>;
      pagination: { total: number };
    };
    expect(body.data.map((incident) => incident.id)).toEqual(["inc_open_h", "inc_resolved_h"]);
    expect(body.pagination.total).toBe(2);
    expect(body.data.every((incident) => incident.monitorId === "mon_hist")).toBe(true);
  });

  it("404s for an unknown monitor", async () => {
    const response = await request("/api/monitors/mon_nope/incidents");
    expect(response.status).toBe(404);
  });
});
