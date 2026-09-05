/**
 * Issue #5 — Monitors CRUD, validation, duplicate warning, and PRD §23
 * disable/re-enable/archive semantics, against real D1 (miniflare).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeTestDb, createTestDb, LOCAL_ORIGIN, type TestD1 } from "../helpers/d1";
import app from "../../worker/app";
import { getDb } from "../../worker/lib/db";
import { incidents, monitorState, monitors } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { Env } from "../../worker/env";

const NOW = "2026-09-05T12:00:00.000Z";

let testDb: TestD1;
let env: Env;

async function request(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}): Promise<Response> {
  return app.request(path, init, { ...testDb.env, ...overrides } as Env);
}

async function json(
  path: string,
  method: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json", Origin: LOCAL_ORIGIN, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function validMonitor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: "cli_morabeza",
    name: "Contabilistas Homepage",
    url: "https://contabilistas.cv/",
    method: "GET",
    ...overrides,
  };
}

beforeAll(async () => {
  testDb = await createTestDb();
  env = testDb.env;
  const db = getDb(env);
  // Open-incident fixture for the disable test.
  await db.insert(monitors).values({
    id: "mon_inc",
    clientId: "cli_morabeza",
    name: "Incident Fixture",
    url: "https://inc.example.com/",
    nextCheckAt: "2026-09-04T12:00:00.000Z", // in the past, so re-enable can refresh it
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(monitorState).values({
    monitorId: "mon_inc",
    status: "down",
    consecutiveFailures: 3,
    failureSequenceStartedAt: NOW,
    stateVersion: 5,
    updatedAt: NOW,
  });
  await db.insert(incidents).values({
    id: "inc_open",
    monitorId: "mon_inc",
    status: "open",
    openedAt: NOW,
    firstFailureAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db
    .update(monitorState)
    .set({ openIncidentId: "inc_open" })
    .where(eq(monitorState.monitorId, "mon_inc"));
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("monitor creation + validation (PRD §22)", () => {
  it("creates a monitor with spec defaults and an unknown state row", async () => {
    const res = await json("/api/monitors", "POST", validMonitor());

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown>; warning?: string };
    expect(body.data).toMatchObject({
      method: "GET",
      intervalSeconds: 300,
      timeoutMs: 10000,
      failureThreshold: 3,
      recoveryThreshold: 2,
      cacheBust: false,
      enabled: true,
      expectedStatusCodes: [200],
      archivedAt: null,
      state: { status: "unknown" },
    });
    expect(body.warning).toBeUndefined();
  });

  it("warns on probable client+url+method duplicates (PRD §17.2)", async () => {
    const res = await json("/api/monitors", "POST", validMonitor({ name: "Same Target Different Assertions" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { warning?: string };
    expect(body.warning).toContain("probable duplicate");
  });

  it("rejects out-of-spec values with field-level details", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [validMonitor({ intervalSeconds: 90 }), "intervalSeconds"],
      [validMonitor({ timeoutMs: 500 }), "timeoutMs"],
      [validMonitor({ timeoutMs: 61000 }), "timeoutMs"],
      [validMonitor({ failureThreshold: 11 }), "failureThreshold"],
      [validMonitor({ recoveryThreshold: 0 }), "recoveryThreshold"],
      [validMonitor({ expectedStatusCodes: [99] }), "expectedStatusCodes"],
      [validMonitor({ maxResponseTimeMs: 0 }), "maxResponseTimeMs"],
      [validMonitor({ clientId: "cli_missing" }), "clientId"],
      [validMonitor({ url: "http://localhost/" }), "url"],
      [validMonitor({ url: "https://user:pass@example.com/" }), "url"],
    ];

    for (const [payload, path] of cases) {
      const res = await json("/api/monitors", "POST", payload);
      expect(res.status, `${JSON.stringify(payload)} should be 400`).toBe(400);
      const body = (await res.json()) as { error: { category: string; details: Array<{ path: string }> } };
      expect(body.error.category).toBe("validation");
      // Array-index paths (e.g. expectedStatusCodes.0) count as a match.
      expect(body.error.details.some((detail) => detail.path === path || detail.path.startsWith(`${path}.`))).toBe(true);
    }
  });

  it("rejects sensitive headers explicitly (PRD §10.9)", async () => {
    const res = await json("/api/monitors", "POST", validMonitor({ headers: { Authorization: "Bearer x" } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: Array<{ message: string }> } };
    expect(body.error.details[0]?.message).toContain("Authorization");
  });

  it("rejects requestBody on non-POST monitors", async () => {
    const res = await json("/api/monitors", "POST", validMonitor({ requestBody: "{}" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: Array<{ path: string }> } };
    expect(body.error.details.some((detail) => detail.path === "requestBody")).toBe(true);
  });
});

describe("monitor list + detail", () => {
  it("lists with clientId filter and excludes archived by default", async () => {
    const res = await request("/api/monitors?clientId=cli_morabeza");
    const body = (await res.json()) as { data: Array<{ id: string; state: { status: string } | null }> };
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.data.every((monitor) => monitor.state !== null)).toBe(true);
  });
});

describe("disable / re-enable semantics (PRD §23)", () => {
  it("disabling pauses, resets counters, and closes the open incident as monitor_disabled", async () => {
    const res = await json("/api/monitors/mon_inc", "PATCH", { enabled: false });
    expect(res.status).toBe(200);

    const [state] = await getDb(env).select().from(monitorState).where(eq(monitorState.monitorId, "mon_inc"));
    expect(state).toMatchObject({
      status: "paused",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      openIncidentId: null,
    });

    const [incident] = await getDb(env).select().from(incidents).where(eq(incidents.id, "inc_open"));
    expect(incident).toMatchObject({
      status: "closed_admin",
      resolutionReason: "monitor_disabled",
    });
    expect(incident.resolvedAt).not.toBeNull();

    // §23: no RECOVERED notification is sent — nothing enqueued, none created.
    const events = await testDb.d1.prepare("SELECT COUNT(*) AS n FROM notification_events").first<{ n: number }>();
    expect(events?.n).toBe(0);
  });

  it("re-enabling returns the monitor to unknown with counters reset and next_check_at refreshed", async () => {
    const before = await getDb(env).select().from(monitors).where(eq(monitors.id, "mon_inc"));
    const res = await json("/api/monitors/mon_inc", "PATCH", { enabled: true });
    expect(res.status).toBe(200);

    const [state] = await getDb(env).select().from(monitorState).where(eq(monitorState.monitorId, "mon_inc"));
    expect(state).toMatchObject({ status: "unknown", consecutiveFailures: 0, consecutiveSuccesses: 0 });

    const [monitor] = await getDb(env).select().from(monitors).where(eq(monitors.id, "mon_inc"));
    expect(monitor.nextCheckAt >= before[0].nextCheckAt).toBe(true);
  });
});

describe("archive semantics (PRD §23)", () => {
  it("archives instead of deleting; history and the row survive", async () => {
    const created = await json("/api/monitors", "POST", validMonitor({ name: "Doomed", url: "https://doomed.example.com/" }));
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    const deleted = await json(`/api/monitors/${id}`, "DELETE");
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as { data: { archivedAt: string | null; enabled: boolean } };
    expect(body.data.archivedAt).not.toBeNull();
    expect(body.data.enabled).toBe(false);

    const defaultList = (await (await request("/api/monitors")).json()) as { data: Array<{ id: string }> };
    expect(defaultList.data.some((monitor) => monitor.id === id)).toBe(false);

    const archivedList = (await (await request("/api/monitors?includeArchived=true")).json()) as {
      data: Array<{ id: string }>;
    };
    expect(archivedList.data.some((monitor) => monitor.id === id)).toBe(true);

    const detail = await request(`/api/monitors/${id}`);
    expect(detail.status).toBe(200);

    const row = await testDb.d1.prepare("SELECT COUNT(*) AS n FROM monitors WHERE id = ?").bind(id).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe("audit trail", () => {
  it("audits monitor mutations", async () => {
    const created = await json("/api/monitors", "POST", validMonitor({ name: "Audited", url: "https://audit.example.com/" }));
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    await json(`/api/monitors/${id}`, "PATCH", { name: "Audited 2" });
    await json(`/api/monitors/${id}`, "DELETE");

    const rows = await testDb.d1
      .prepare("SELECT action FROM audit_events WHERE entity_id = ? ORDER BY created_at")
      .bind(id)
      .all<{ action: string }>();
    expect(rows.results.map((row) => row.action)).toEqual(["monitor.create", "monitor.update", "monitor.archive"]);
  });
});
