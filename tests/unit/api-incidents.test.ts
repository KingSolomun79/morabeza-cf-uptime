/**
 * Issue #13 — incident read APIs (PRD §24): open-first listing with
 * pagination (PRD §27.7 + §24 pagination note) and full-record detail.
 * Real D1 via miniflare; incidents seeded directly (lifecycle wiring is
 * covered in incidents.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeTestDb, createTestDb, LOCAL_ORIGIN, type TestD1 } from "../helpers/d1";
import app from "../../worker/app";
import { getDb } from "../../worker/lib/db";
import { incidents, monitors } from "../../db/schema";

const NOW = "2026-09-05T12:00:00.000Z";
const MON = "mon_inc_api";
const OTHER = "mon_inc_api2";

let testDb: TestD1;

async function request(path: string): Promise<Response> {
  return app.request(path, {
    method: "GET",
    headers: { Origin: LOCAL_ORIGIN, "X-Dev-Access-Email": "jo@morabeza.cv" },
  }, testDb.env);
}

async function seedIncident(values: {
  id: string;
  monitorId: string;
  status: "open" | "resolved";
  openedAt: string;
  resolvedAt?: string;
  outageDurationMs?: number;
}): Promise<void> {
  const db = getDb(testDb.env);
  await db.insert(incidents).values({
    id: values.id,
    monitorId: values.monitorId,
    status: values.status,
    openedAt: values.openedAt,
    firstFailureAt: values.openedAt,
    resolvedAt: values.resolvedAt ?? null,
    triggerCheckId: `${values.monitorId}:trigger`,
    recoveryCheckId: values.resolvedAt ? `${values.monitorId}:recovery` : null,
    openReasonCode: "unexpected_status",
    outageDurationMs: values.outageDurationMs ?? null,
    resolutionReason: values.resolvedAt ? "recovered" : null,
    createdAt: values.openedAt,
    updatedAt: values.resolvedAt ?? values.openedAt,
  });
}

beforeAll(async () => {
  testDb = await createTestDb();
  const db = getDb(testDb.env);
  for (const id of [MON, OTHER]) {
    await db.insert(monitors).values({
      id,
      clientId: "cli_morabeza",
      name: `Incident API fixture ${id}`,
      url: "https://target.example.com/health",
      nextCheckAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  // Newest row is OPEN (sorts first); resolved rows sort after, newest first.
  await seedIncident({ id: "inc_res_old", monitorId: MON, status: "resolved", openedAt: "2026-09-01T10:00:00.000Z", resolvedAt: "2026-09-01T11:00:00.000Z", outageDurationMs: 3_600_000 });
  await seedIncident({ id: "inc_res_mid", monitorId: MON, status: "resolved", openedAt: "2026-09-03T10:00:00.000Z", resolvedAt: "2026-09-03T10:30:00.000Z", outageDurationMs: 1_800_000 });
  await seedIncident({ id: "inc_open", monitorId: MON, status: "open", openedAt: "2026-09-05T11:00:00.000Z" });
  await seedIncident({ id: "inc_other", monitorId: OTHER, status: "resolved", openedAt: "2026-09-02T10:00:00.000Z", resolvedAt: "2026-09-02T10:05:00.000Z", outageDurationMs: 300_000 });
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("GET /api/incidents", () => {
  it("lists open first, then resolved newest-first, with pagination totals", async () => {
    const res = await request("/api/incidents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; status: string }>;
      pagination: { total: number; limit: number; offset: number };
    };
    expect(body.data.map((i) => i.id)).toEqual(["inc_open", "inc_res_mid", "inc_other", "inc_res_old"]);
    expect(body.pagination).toEqual({ total: 4, limit: 50, offset: 0 });
  });

  it("paginates with limit/offset and keeps the total stable", async () => {
    const res = await request("/api/incidents?limit=2&offset=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string }>;
      pagination: { total: number; limit: number; offset: number };
    };
    expect(body.data.map((i) => i.id)).toEqual(["inc_res_mid", "inc_other"]);
    expect(body.pagination).toEqual({ total: 4, limit: 2, offset: 1 });
  });

  it.each([
    ["limit=0", "/api/incidents?limit=0"],
    ["limit above the cap", "/api/incidents?limit=201"],
    ["negative offset", "/api/incidents?offset=-1"],
    ["non-numeric limit", "/api/incidents?limit=many"],
  ])("rejects invalid pagination: %s", async (_name, path) => {
    const res = await request(path);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { category: string } };
    expect(body.error.category).toBe("validation");
  });
});

describe("GET /api/incidents/:id", () => {
  it("returns the full incident record", async () => {
    const res = await request("/api/incidents/inc_res_mid");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      id: "inc_res_mid",
      monitorId: MON,
      status: "resolved",
      openedAt: "2026-09-03T10:00:00.000Z",
      firstFailureAt: "2026-09-03T10:00:00.000Z",
      resolvedAt: "2026-09-03T10:30:00.000Z",
      triggerCheckId: `${MON}:trigger`,
      recoveryCheckId: `${MON}:recovery`,
      openReasonCode: "unexpected_status",
      outageDurationMs: 1_800_000,
      resolutionReason: "recovered",
      createdAt: "2026-09-03T10:00:00.000Z",
      updatedAt: "2026-09-03T10:30:00.000Z",
    });
  });

  it("404s for unknown incidents", async () => {
    const res = await request("/api/incidents/inc_nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { category: string } };
    expect(body.error.category).toBe("not_found");
  });
});
