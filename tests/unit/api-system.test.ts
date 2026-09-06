/**
 * Issue #26 — system report, dead-letter ops, and the delivery log
 * (PRD §24, §27.9, §27.10), against real D1 (miniflare).
 *
 * Covers the ACs: /api/system shape + freshness (incl. the shared #11 law
 * and bootstrap fresh-unknown), auth rejection, dead-letter list + resolve
 * with notes (idempotent, audited), and the notification-events delivery
 * log with status/attempts/last_error.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeTestDb, createTestDb, LOCAL_ORIGIN, type TestD1 } from "../helpers/d1";
import app from "../../worker/app";
import { getDb } from "../../worker/lib/db";
import { auditEvents, deadLetterEvents, notificationEvents, notificationTargets, systemState } from "../../db/schema";
import { eq as eq2 } from "drizzle-orm";
import type { Env } from "../../worker/env";

const NOW = "2026-09-06T12:00:00.000Z";

let testDb: TestD1;
let env: Env;

async function request(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Origin: LOCAL_ORIGIN, "X-Dev-Access-Email": "ops@morabeza.cv", ...(init.headers ?? {}) },
  }, { ...testDb.env, ...overrides } as Env);
}

beforeAll(async () => {
  testDb = await createTestDb();
  env = testDb.env;
  const db = getDb(env);

  // A stale scheduler heartbeat (written 1h before NOW; limit is 3m) plus a
  // never-written consumer — exercises stale AND fresh-unknown in one report.
  await db.insert(systemState).values({
    id: "system",
    lastSchedulerAt: "2026-09-06T11:00:00.000Z",
    updatedAt: NOW,
  });

  await db.insert(deadLetterEvents).values([
    {
      id: "dlq_1",
      originalJobId: "mon_x:slot",
      messageType: "monitor.check",
      payloadSummaryJson: JSON.stringify({ summary: '{"monitorId":"mon_x"}' }),
      failureReason: "exhausted retries",
      receivedAt: "2026-09-06T10:00:00.000Z",
    },
    {
      id: "dlq_2",
      originalJobId: "mon_y:slot",
      messageType: "notification.send",
      payloadSummaryJson: JSON.stringify({ summary: '{"eventId":"evt_1"}' }),
      failureReason: "email provider down",
      receivedAt: "2026-09-05T10:00:00.000Z",
      resolvedAt: "2026-09-05T11:00:00.000Z",
      resolutionNotes: "provider outage over",
    },
  ]);

  const [target] = await db
    .insert(notificationTargets)
    .values({ id: "tgt_1", name: "Ops", email: "ops@morabeza.cv", isDefault: 1, createdAt: NOW, updatedAt: NOW })
    .returning();

  await db.insert(notificationEvents).values([
    {
      id: "evt_old",
      dedupeKey: "dedupe:old",
      monitorId: null,
      targetId: target.id,
      type: "test",
      status: "failed",
      attempts: 3,
      lastError: "SMTP connection refused",
      createdAt: "2026-09-06T09:00:00.000Z",
      updatedAt: "2026-09-06T09:05:00.000Z",
    },
    {
      id: "evt_new",
      dedupeKey: "dedupe:new",
      monitorId: null,
      targetId: target.id,
      type: "test",
      status: "sent",
      attempts: 1,
      providerMessageId: "pm_1",
      createdAt: "2026-09-06T11:30:00.000Z",
      sentAt: "2026-09-06T11:30:10.000Z",
      updatedAt: "2026-09-06T11:30:10.000Z",
    },
  ]);
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("GET /api/system (#26)", () => {
  it("reports heartbeats under the shared freshness law, retention, DLQ count, and metadata", async () => {
    const response = await request("/api/system");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: {
      d1: { reachable: boolean };
      heartbeats: Record<string, { at: string | null; status: string }>;
      retention: Record<string, number>;
      deadLetters: { unresolved: number };
      emailConfigured: boolean;
      version: string | null;
    } };
    const report = body.data;

    expect(report.d1).toEqual({ reachable: true });
    // Scheduler heartbeat is 1h old (limit 3m) → stale; consumer never ran →
    // fresh-unknown (the #11 bootstrap grace), surfaced as "never_run".
    expect(report.heartbeats.scheduler).toEqual({ at: "2026-09-06T11:00:00.000Z", status: "stale" });
    expect(report.heartbeats.queueConsumer).toEqual({ at: null, status: "never_run" });
    expect(report.heartbeats.hourlyRollup.status).toBe("never_run");
    // Effective §18 defaults from wrangler vars/absence.
    expect(report.retention).toEqual({ rawCheckDays: 7, hourlyDays: 90, dailyDays: 730 });
    expect(report.deadLetters).toEqual({ unresolved: 1 });
    // APP_VERSION is set in wrangler vars; test env has no EMAIL binding.
    expect(report.emailConfigured).toBe(false);

    // Secret hygiene by construction: no account/token/secret-shaped keys.
    const keys = Object.keys(report).sort();
    expect(keys).toEqual(["d1", "deadLetters", "emailConfigured", "heartbeats", "now", "retention", "version"].sort());
  });

  it("reflects the APP_VERSION var when present", async () => {
    const response = await request("/api/system", {}, { APP_VERSION: "9.9.9-test" });
    const body = (await response.json()) as { data: { version: string | null } };
    expect(body.data.version).toBe("9.9.9-test");
  });

  it("rejects unauthenticated requests like every /api route (locked mode)", async () => {
    const response = await request("/api/system", {}, { APP_ACCESS_MODE: "locked" });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { category: string } };
    expect(body.error.category).toBe("authentication_required");
  });
});

describe("Dead-letter ops (#26)", () => {
  it("lists unresolved letters by default, newest first, with pagination", async () => {
    const response = await request("/api/dead-letters");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id: string; resolvedAt: string | null }>;
      pagination: { total: number };
    };
    expect(body.data.map((letter) => letter.id)).toEqual(["dlq_1"]);
    expect(body.pagination).toEqual({ total: 1, limit: 50, offset: 0 });
  });

  it("filters resolved letters and supports filter=all", async () => {
    const resolved = await request("/api/dead-letters?filter=resolved");
    const resolvedBody = (await resolved.json()) as { data: Array<{ id: string; resolutionNotes: string | null }>; pagination: { total: number } };
    expect(resolvedBody.data.map((letter) => letter.id)).toEqual(["dlq_2"]);
    expect(resolvedBody.data[0].resolutionNotes).toBe("provider outage over");
    expect(resolvedBody.pagination.total).toBe(1);

    const all = await request("/api/dead-letters?filter=all");
    const allBody = (await all.json()) as { pagination: { total: number } };
    expect(allBody.pagination.total).toBe(2);
  });

  it("resolves with notes (audit row written) and is idempotent on a second PATCH", async () => {
    const first = await request("/api/dead-letters/dlq_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "monitor was deleted; job was stale" }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { resolvedAt: string | null; resolutionNotes: string | null }; warning?: string };
    expect(firstBody.data.resolvedAt).toBeTruthy();
    expect(firstBody.data.resolutionNotes).toBe("monitor was deleted; job was stale");
    expect(firstBody.warning).toBeUndefined();

    // Idempotent re-resolve: first resolution preserved, warning surfaced.
    const second = await request("/api/dead-letters/dlq_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "different notes ignored" }),
    });
    const secondBody = (await second.json()) as { data: { resolutionNotes: string | null }; warning?: string };
    expect(secondBody.data.resolutionNotes).toBe("monitor was deleted; job was stale");
    expect(secondBody.warning).toBe("dead letter was already resolved");

    // Exactly one audit row for the resolve (route-level audit).
    const db = getDb(env);
    const audits = await db.select().from(auditEvents).where(eq2(auditEvents.action, "dead_letter.resolve"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityId).toBe("dlq_1");
  });

  it("404s an unknown dead letter and 400s an invalid filter", async () => {
    const missing = await request("/api/dead-letters/dlq_nope", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: null }),
    });
    expect(missing.status).toBe(404);

    const badFilter = await request("/api/dead-letters?filter=nope");
    expect(badFilter.status).toBe(400);
  });
});

describe("GET /api/notification-events (#26)", () => {
  it("lists the delivery log newest-first with the target email joined", async () => {
    const response = await request("/api/notification-events");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id: string; type: string; status: string; attempts: number; lastError: string | null; targetEmail: string }>;
      pagination: { total: number };
    };
    expect(body.data.map((event) => event.id)).toEqual(["evt_new", "evt_old"]);
    expect(body.data[0]).toMatchObject({ status: "sent", attempts: 1, targetEmail: "ops@morabeza.cv", lastError: null });
    expect(body.data[1]).toMatchObject({ status: "failed", attempts: 3, lastError: "SMTP connection refused" });
    expect(body.pagination.total).toBe(2);
  });

  it("filters by targetId", async () => {
    const response = await request("/api/notification-events?targetId=tgt_1");
    const body = (await response.json()) as { pagination: { total: number } };
    expect(body.pagination.total).toBe(2);

    const other = await request("/api/notification-events?targetId=tgt_other");
    const otherBody = (await other.json()) as { data: unknown[]; pagination: { total: number } };
    expect(otherBody.data).toEqual([]);
    expect(otherBody.pagination.total).toBe(0);
  });
});
