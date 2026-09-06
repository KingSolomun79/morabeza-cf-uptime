/**
 * Issue #11 — public /healthz with real degradation checks (PRD §19):
 * fresh heartbeats → 200 ok; stale scheduler/consumer or D1 failure → 503
 * degraded; bootstrap grace for a never-run system_state row; strictly the
 * two-field JSON contract; anonymous by design while /api stays protected.
 * Real D1 via miniflare.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeTestDb, createTestDb, type TestD1 } from "../helpers/d1";
import app from "../../worker/app";
import { getDb } from "../../worker/lib/db";
import { systemState } from "../../db/schema";
import { eq } from "drizzle-orm";
import { evaluateHealth, SCHEDULER_FRESHNESS_LIMIT_MS, CONSUMER_FRESHNESS_LIMIT_MS } from "../../worker/services/healthz";

const NOW = "2026-09-05T12:00:00.000Z";

let testDb: TestD1;

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** Overwrites the system_state row (or removes it when heartbeats are null). */
async function setHeartbeats(schedulerMinutesAgo: number | null, consumerMinutesAgo: number | null): Promise<void> {
  const db = getDb(testDb.env);
  await db.delete(systemState).where(eq(systemState.id, "system"));
  if (schedulerMinutesAgo === null && consumerMinutesAgo === null) return; // no row at all
  await db.insert(systemState).values({
    id: "system",
    lastSchedulerAt: schedulerMinutesAgo === null ? null : minutesAgoIso(schedulerMinutesAgo),
    lastQueueConsumerAt: consumerMinutesAgo === null ? null : minutesAgoIso(consumerMinutesAgo),
    updatedAt: NOW,
  });
}

async function healthz(): Promise<Response> {
  // Deliberately NO auth headers: the route is the anonymous exception.
  return app.request("/healthz", { method: "GET" }, testDb.env);
}

beforeAll(async () => {
  testDb = await createTestDb();
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("evaluateHealth (service-level, injected clock)", () => {
  it("fresh heartbeats → ok", async () => {
    const env = testDb.env;
    const { touchSchedulerHeartbeat, touchQueueConsumerHeartbeat } = await import("../../worker/repositories/system");
    await touchSchedulerHeartbeat(env);
    await touchQueueConsumerHeartbeat(env);
    const result = await evaluateHealth(env, new Date().toISOString());
    expect(result).toEqual({ status: "ok", checks: { d1: true, scheduler: true, consumer: true } });
  });

  it("limits match PRD §19 (scheduler ≤3 min, consumer ≤10 min)", () => {
    expect(SCHEDULER_FRESHNESS_LIMIT_MS).toBe(180_000);
    expect(CONSUMER_FRESHNESS_LIMIT_MS).toBe(600_000);
  });

  it("a heartbeat at exactly the limit is still fresh (inclusive bound)", async () => {
    const env = testDb.env;
    const now = "2026-09-05T12:10:00.000Z";
    const db = getDb(env);
    await db.delete(systemState).where(eq(systemState.id, "system"));
    await db.insert(systemState).values({
      id: "system",
      lastSchedulerAt: "2026-09-05T12:07:00.000Z", // exactly 3 min
      lastQueueConsumerAt: "2026-09-05T12:00:00.000Z", // exactly 10 min
      updatedAt: now,
    });
    const result = await evaluateHealth(env, now);
    expect(result.status).toBe("ok");
  });

  it("an unparseable timestamp degrades (fail-closed: NaN is never fresh)", async () => {
    const env = testDb.env;
    const db = getDb(env);
    await db.delete(systemState).where(eq(systemState.id, "system"));
    await db.insert(systemState).values({
      id: "system",
      lastSchedulerAt: "not-a-date",
      lastQueueConsumerAt: new Date().toISOString(),
      updatedAt: NOW,
    });
    const result = await evaluateHealth(env, new Date().toISOString());
    expect(result.status).toBe("degraded");
    expect(result.checks.scheduler).toBe(false);
    expect(result.checks.d1).toBe(true);
  });
});

describe("GET /healthz (route contract, PRD §19 + §8.2)", () => {
  it("fresh heartbeats + working D1 → 200 ok exactly, with no-store", async () => {
    await setHeartbeats(0.2, 0.2);
    const res = await healthz();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.text()).toBe('{"status":"ok"}');
  });

  it("stale scheduler heartbeat (>3 min) → 503 degraded", async () => {
    await setHeartbeats(4, 0.2);
    const res = await healthz();
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"status":"degraded"}');
  });

  it("stale consumer heartbeat (>10 min) → 503 degraded", async () => {
    await setHeartbeats(0.2, 11);
    const res = await healthz();
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"status":"degraded"}');
  });

  it("both heartbeats stale → 503 degraded", async () => {
    await setHeartbeats(30, 30);
    const res = await healthz();
    expect(res.status).toBe(503);
  });

  it("bootstrap grace: no system_state row at all → 200 ok (fresh-unknown, non-flapping)", async () => {
    await setHeartbeats(null, null);
    const res = await healthz();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"status":"ok"}');
  });

  it("bootstrap grace per component: a component that never ran stays ok; one that ran and stopped degrades", async () => {
    // Row exists (consumer ran) but scheduler never ticked → fresh-unknown.
    await setHeartbeats(null, 0.2);
    expect((await healthz()).status).toBe(200);

    // Scheduler ran once, then went quiet past the limit → degraded.
    await setHeartbeats(5, 0.2);
    expect((await healthz()).status).toBe(503);
  });

  it("D1 failure → 503 degraded", async () => {
    await setHeartbeats(0.2, 0.2);
    const broken = {
      ...testDb.env,
      DB: {
        prepare: () => {
          throw new Error("d1 unavailable");
        },
      } as unknown as D1Database,
    } as typeof testDb.env;
    const res = await app.request("/healthz", { method: "GET" }, broken);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"status":"degraded"}');
  });

  it("response carries no data beyond the status word", async () => {
    await setHeartbeats(0.2, 0.2);
    const res = await healthz();
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["status"]);
    expect(body.status === "ok" || body.status === "degraded").toBe(true);
  });

  it("/healthz sits outside the auth group: it serves even in locked mode while /api fails closed", async () => {
    await setHeartbeats(0.2, 0.2);
    const locked = { ...testDb.env, APP_ACCESS_MODE: "locked" as const };

    // The anonymous exception (PRD §8.2): no identity, no Origin — served.
    const health = await app.request("/healthz", { method: "GET" }, locked);
    expect(health.status).toBe(200);

    // Everything under /api is rejected by the fail-closed middleware group.
    const api = await app.request("/api/monitors", { method: "GET" }, locked);
    expect(api.status).toBe(401);
  });
});
