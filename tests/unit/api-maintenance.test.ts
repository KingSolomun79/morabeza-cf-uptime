/**
 * Issue #15 — maintenance window CRUD API (PRD §14, §24): full validation
 * (scope consistency, references, bounds), cancel-not-delete semantics,
 * terminal cancelled windows, and audit events. Real D1 via miniflare.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeTestDb, createTestDb, LOCAL_ORIGIN, type TestD1 } from "../helpers/d1";
import app from "../../worker/app";
import { getDb } from "../../worker/lib/db";
import { monitors } from "../../db/schema";

const NOW = "2026-09-05T12:00:00.000Z";

let testDb: TestD1;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function request(path: string, method: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Origin: LOCAL_ORIGIN, "X-Dev-Access-Email": "jo@morabeza.cv" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testDb.env);
}

function validWindow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "DB failover drill",
    description: "planned provider maintenance",
    scopeType: "monitor",
    scopeId: "mon_win",
    startsAt: iso(-60_000),
    endsAt: iso(3_600_000),
    ...overrides,
  };
}

beforeAll(async () => {
  testDb = await createTestDb();
  const db = getDb(testDb.env);
  await db.insert(monitors).values({
    id: "mon_win",
    clientId: "cli_morabeza",
    name: "Window Fixture",
    url: "https://target.example.com/health",
    nextCheckAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("POST /api/maintenance (PRD §14.2 validation)", () => {
  it("creates a valid monitor-scope window with createdBy = actor", async () => {
    const res = await request("/api/maintenance", "POST", validWindow());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      scopeType: "monitor",
      scopeId: "mon_win",
      cancelledAt: null,
      createdBy: "jo@morabeza.cv",
    });
    expect(String(body.data.id)).toMatch(/^win_/);
  });

  it.each([
    ["global with a scopeId is rejected", { scopeType: "global", scopeId: "cli_morabeza" }, "scopeId"],
    ["client scope without scopeId is rejected", { scopeType: "client", scopeId: null }, "scopeId"],
    ["monitor scope without scopeId is rejected", { scopeType: "monitor", scopeId: null }, "scopeId"],
    ["unknown client reference is rejected", { scopeType: "client", scopeId: "cli_nope" }, "scopeId"],
    ["unknown monitor reference is rejected", { scopeType: "monitor", scopeId: "mon_nope" }, "scopeId"],
    ["endsAt <= startsAt is rejected", { endsAt: iso(-120_000) }, "endsAt"],
    ["non-ISO timestamps are rejected", { startsAt: "2026-09-05 12:00" }, "startsAt"],
    ["missing title is rejected", { title: "" }, "title"],
  ])("%s", async (_name, overrides, errorPath) => {
    const res = await request("/api/maintenance", "POST", validWindow(overrides as Record<string, unknown>));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: Array<{ path: string }> | null } };
    expect(body.error.details?.some((d) => d.path === errorPath)).toBe(true);
  });
});

describe("PATCH /api/maintenance/:id", () => {
  it("updates fields with merged-record validation", async () => {
    const created = (await (await request("/api/maintenance", "POST", validWindow({ title: "Window A" }))).json()) as { data: { id: string } };

    const res = await request(`/api/maintenance/${created.data.id}`, "PATCH", { title: "Window A renamed" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string } };
    expect(body.data.title).toBe("Window A renamed");

    const bad = await request(`/api/maintenance/${created.data.id}`, "PATCH", { endsAt: iso(-3_600_000) });
    expect(bad.status).toBe(400);
  });

  it("404s for unknown windows", async () => {
    const res = await request("/api/maintenance/win_nope", "PATCH", { title: "x" });
    expect(res.status).toBe(404);
  });

  it("GET /:id returns one window", async () => {
    const created = (await (await request("/api/maintenance", "POST", validWindow({ title: "Fetch me" }))).json()) as { data: { id: string } };
    const res = await request(`/api/maintenance/${created.data.id}`, "GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; title: string } };
    expect(body.data.id).toBe(created.data.id);
    expect(body.data.title).toBe("Fetch me");

    const missing = await request("/api/maintenance/win_nope", "GET");
    expect(missing.status).toBe(404);
  });

  it("PATCH rejects scope-consistency conflicts on the merged record", async () => {
    const created = (await (await request("/api/maintenance", "POST", validWindow({ title: "Scope flip" }))).json()) as { data: { id: string } };

    // Flipping to global while scopeId remains set must conflict.
    const bad = await request(`/api/maintenance/${created.data.id}`, "PATCH", { scopeType: "global" });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: { details: Array<{ path: string }> | null } };
    expect(badBody.error.details?.some((d) => d.path === "scopeId")).toBe(true);

    // Explicitly clearing scopeId makes the same flip valid.
    const good = await request(`/api/maintenance/${created.data.id}`, "PATCH", { scopeType: "global", scopeId: null });
    expect(good.status).toBe(200);
    const goodBody = (await good.json()) as { data: { scopeType: string; scopeId: string | null } };
    expect(goodBody.data).toMatchObject({ scopeType: "global", scopeId: null });
  });
});

describe("DELETE /api/maintenance/:id cancels, never hard-deletes (PRD §24)", () => {
  it("sets cancelled_at, keeps the row, makes the window terminal + never-matching", async () => {
    const created = (await (await request("/api/maintenance", "POST", validWindow({ title: "Cancel me" }))).json()) as { data: { id: string } };

    const del = await request(`/api/maintenance/${created.data.id}`, "DELETE");
    expect(del.status).toBe(200);
    const body = (await del.json()) as { data: { cancelledAt: string | null } };
    expect(body.data.cancelledAt).not.toBeNull();

    const list = (await (await request("/api/maintenance", "GET")).json()) as { data: Array<{ id: string; cancelledAt: string | null }> };
    expect(list.data.find((w) => w.id === created.data.id)?.cancelledAt).not.toBeNull(); // still listed

    const patch = await request(`/api/maintenance/${created.data.id}`, "PATCH", { title: "zombie" });
    expect(patch.status).toBe(409); // cancelled windows are terminal

    const again = await request(`/api/maintenance/${created.data.id}`, "DELETE");
    expect(again.status).toBe(200); // idempotent cancel
  });

  it("404s for unknown windows", async () => {
    const res = await request("/api/maintenance/win_nope", "DELETE");
    expect(res.status).toBe(404);
  });
});

describe("audit events on mutations (PRD §29)", () => {
  it("records create, update, and cancel actions", async () => {
    const actions = await testDb.d1
      .prepare("SELECT DISTINCT action FROM audit_events WHERE entity_type = 'maintenance_window'")
      .all<{ action: string }>();
    const found = actions.results.map((r) => r.action).sort();
    expect(found).toEqual(["maintenance.cancel", "maintenance.create", "maintenance.update"]);
  });
});
