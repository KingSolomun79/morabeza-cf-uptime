/**
 * Issue #16 — notification targets, monitor mappings, and recipient
 * resolution (PRD §17.7/§17.8/§27.9), against real D1 via miniflare.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { eq } from "drizzle-orm";
import app from "../../worker/app";
import { getDb } from "../../worker/lib/db";
import { resolveTargets } from "../../worker/repositories/notifications";
import { monitors, notificationEvents, notificationTargets } from "../../db/schema";
import type { Env } from "../../worker/env";

const migrationFiles = import.meta.glob("../../db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const LOCAL_ORIGIN = "http://localhost:5173";
const NOW = "2026-09-05T12:00:00.000Z";

let mf: Miniflare;
let d1: D1Database;
let env: Env;
let db: ReturnType<typeof getDb>;

async function request(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}): Promise<Response> {
  return app.request(path, init, { DB: d1, APP_ACCESS_MODE: "local", APP_ORIGIN: LOCAL_ORIGIN, ...overrides } as Env);
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

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null); } }",
    d1Databases: { DB: "appdb" },
  });
  d1 = (await mf.getD1Database("DB")) as D1Database;
  env = { DB: d1, APP_ACCESS_MODE: "local", APP_ORIGIN: LOCAL_ORIGIN } as Env;
  db = getDb(env);

  const paths = Object.keys(migrationFiles).sort();
  expect(paths.length).toBe(2);
  for (const path of paths) {
    for (const statement of migrationFiles[path].split("--> statement-breakpoint")) {
      const lines = statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length === 0) continue;
      await d1.exec(lines.join(" "));
    }
  }

  // Fixture monitor for mapping tests.
  await db.insert(monitors).values({
    id: "mon_nt",
    clientId: "cli_morabeza",
    name: "Notification Fixture",
    url: "https://example.com/",
    nextCheckAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}, 30000);

afterAll(async () => {
  await mf?.dispose();
});

describe("target CRUD (PRD §24)", () => {
  it("creates targets; duplicate emails conflict; invalid email is a validation error", async () => {
    const created = await json("/api/notification-targets", "POST", {
      name: "Ops",
      email: "ops@morabeza.digital",
      isDefault: true,
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data: { id: string; enabled: boolean; isDefault: boolean } };
    expect(body.data.id).toMatch(/^tgt_/);
    expect(body.data).toMatchObject({ enabled: true, isDefault: true });

    const duplicate = await json("/api/notification-targets", "POST", {
      name: "Ops copy",
      email: "ops@morabeza.digital",
    });
    expect(duplicate.status).toBe(409);

    const invalid = await json("/api/notification-targets", "POST", { name: "Bad", email: "not-an-email" });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { category: string } }).error.category).toBe("validation");
  });

  it("lists targets", async () => {
    await json("/api/notification-targets", "POST", { name: "Second", email: "second@morabeza.digital" });

    const res = await request("/api/notification-targets");
    const body = (await res.json()) as { data: Array<{ email: string }> };
    const emails = body.data.map((target) => target.email);
    expect(emails).toContain("ops@morabeza.digital");
    expect(emails).toContain("second@morabeza.digital");
  });

  it("patches name, email, enabled, isDefault; email conflicts are 409", async () => {
    const created = await json("/api/notification-targets", "POST", { name: "Temp", email: "temp@morabeza.digital" });
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    const patched = await json(`/api/notification-targets/${id}`, "PATCH", {
      name: "Temp Renamed",
      enabled: false,
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { data: { name: string; enabled: boolean } }).data).toMatchObject({
      name: "Temp Renamed",
      enabled: false,
    });

    const conflict = await json(`/api/notification-targets/${id}`, "PATCH", { email: "ops@morabeza.digital" });
    expect(conflict.status).toBe(409);
  });

  it("deletes unreferenced targets but refuses targets with notification history", async () => {
    const fresh = await json("/api/notification-targets", "POST", { name: "Fresh", email: "fresh@morabeza.digital" });
    const { id: freshId } = ((await fresh.json()) as { data: { id: string } }).data;

    const deleted = await json(`/api/notification-targets/${freshId}`, "DELETE");
    expect(deleted.status).toBe(200);

    // Give the ops target notification history (as the #17 pipeline would).
    const ops = await db
      .select({ id: notificationTargets.id })
      .from(notificationTargets)
      .where(eq(notificationTargets.email, "ops@morabeza.digital"));
    const opsId = ops[0]?.id as string;
    await db.insert(notificationEvents).values({
      id: "evt_hist",
      dedupeKey: "inc_x:down:" + opsId,
      monitorId: "mon_nt",
      targetId: opsId,
      type: "down",
      status: "sent",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const refused = await json(`/api/notification-targets/${opsId}`, "DELETE");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("disable");
  });
});

describe("monitor mappings (PRD §17.8)", () => {
  it("replaces the explicit mapping set; validates monitor and targets", async () => {
    const first = await json("/api/notification-targets", "POST", { name: "Map A", email: "map-a@morabeza.digital" });
    const second = await json("/api/notification-targets", "POST", { name: "Map B", email: "map-b@morabeza.digital" });
    const idA = ((await first.json()) as { data: { id: string } }).data.id;
    const idB = ((await second.json()) as { data: { id: string } }).data.id;

    const put = await json("/api/monitors/mon_nt/notification-targets", "PUT", { targetIds: [idA, idB] });
    expect(put.status).toBe(200);

    // Replace with a subset.
    const replaced = await json("/api/monitors/mon_nt/notification-targets", "PUT", { targetIds: [idA] });
    expect(((await replaced.json()) as { data: string[] }).data).toEqual([idA]);

    const unknownTarget = await json("/api/monitors/mon_nt/notification-targets", "PUT", {
      targetIds: ["tgt_missing"],
    });
    expect(unknownTarget.status).toBe(400);

    const unknownMonitor = await json("/api/monitors/mon_missing/notification-targets", "PUT", {
      targetIds: [idA],
    });
    expect(unknownMonitor.status).toBe(404);
  });
});

describe("resolveTargets contract (PRD §17.8)", () => {
  it("returns enabled explicit mappings without fallback to defaults", async () => {
    const a = await json("/api/notification-targets", "POST", { name: "RA", email: "ra@morabeza.digital" });
    const b = await json("/api/notification-targets", "POST", { name: "RB", email: "rb@morabeza.digital" });
    const defaultTarget = await json("/api/notification-targets", "POST", {
      name: "RD",
      email: "rd@morabeza.digital",
      isDefault: true,
    });
    const idA = ((await a.json()) as { data: { id: string } }).data.id;
    const idB = ((await b.json()) as { data: { id: string } }).data.id;
    const idDefault = ((await defaultTarget.json()) as { data: { id: string } }).data.id;

    await db.insert(monitors).values({
      id: "mon_explicit",
      clientId: "cli_morabeza",
      name: "Explicit",
      url: "https://example.com/",
      nextCheckAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await json("/api/monitors/mon_explicit/notification-targets", "PUT", { targetIds: [idA, idB] });

    // Explicit wins even when defaults exist; both explicit targets enabled.
    const explicit = await resolveTargets(env, "mon_explicit");
    expect(explicit.map((target) => target.id).sort()).toEqual([idA, idB].sort());
    expect(explicit.some((target) => target.id === idDefault)).toBe(false);

    // Disable one explicit target → only the enabled one remains (no fallback).
    await json(`/api/notification-targets/${idB}`, "PATCH", { enabled: false });
    const afterDisable = await resolveTargets(env, "mon_explicit");
    expect(afterDisable.map((target) => target.id)).toEqual([idA]);
  });

  it("explicit-but-all-disabled yields no recipients (no silent fallback)", async () => {
    const a = await json("/api/notification-targets", "POST", { name: "SA", email: "sa@morabeza.digital" });
    const idA = ((await a.json()) as { data: { id: string } }).data.id;
    await db.insert(monitors).values({
      id: "mon_all_disabled",
      clientId: "cli_morabeza",
      name: "All Disabled",
      url: "https://example.com/",
      nextCheckAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await json("/api/monitors/mon_all_disabled/notification-targets", "PUT", { targetIds: [idA] });
    await json(`/api/notification-targets/${idA}`, "PATCH", { enabled: false });

    const resolved = await resolveTargets(env, "mon_all_disabled");
    expect(resolved).toEqual([]);
  });

  it("falls back to enabled defaults when a monitor has no explicit mappings", async () => {
    const resolved = await resolveTargets(env, "mon_nt");
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    expect(resolved.every((target) => target.email.endsWith("@morabeza.digital"))).toBe(true);

    // A monitor whose mappings were cleared returns to the default fallback.
    await json("/api/monitors/mon_explicit/notification-targets", "PUT", { targetIds: [] });
    const cleared = await resolveTargets(env, "mon_explicit");
    expect(cleared.length).toBeGreaterThanOrEqual(1);
  });
});

describe("audit trail", () => {
  it("audits target and mapping mutations", async () => {
    const created = await json("/api/notification-targets", "POST", { name: "Audit", email: "audit@morabeza.digital" });
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    await json(`/api/notification-targets/${id}`, "PATCH", { name: "Audit 2" });
    await json("/api/monitors/mon_nt/notification-targets", "PUT", { targetIds: [id] });
    await json(`/api/notification-targets/${id}`, "DELETE");

    const result = await d1
      .prepare(
        "SELECT action FROM audit_events WHERE entity_id = ? OR (entity_type = 'monitor' AND entity_id = 'mon_nt') ORDER BY created_at",
      )
      .bind(id)
      .all<{ action: string }>();
    const actions = result.results.map((row) => row.action);

    expect(actions).toContain("notification_target.create");
    expect(actions).toContain("notification_target.update");
    expect(actions).toContain("monitor_notification_targets.set");
    expect(actions).toContain("notification_target.delete");
  });
});
