/**
 * Issue #14 — manual checks (PRD §13, §24): POST /api/monitors/:id/check
 * enqueues a diagnostic-only job (202, unique id), rejects archived/disabled
 * monitors, throttles floods, audits invocations — and the consumer persists
 * the result with ZERO state effects even on a DOWN-bound fixture.
 * Real D1 via miniflare; fetch mocked; queue recorded.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { disposeTestDb, createTestDb, LOCAL_ORIGIN, type TestD1 } from "../helpers/d1";
import app from "../../worker/app";
import { getDb } from "../../worker/lib/db";
import { monitorState, monitors } from "../../db/schema";
import { createQueueConsumer, type BatchLike, type MessageLike } from "../../worker/queue/consumer";
import { QUEUE_NAMES } from "../../worker/queue/schemas";

const NOW = "2026-09-05T12:00:00.000Z";
const URL = "https://target.example.com/health";

let testDb: TestD1;
let queuedBodies: QueuedBody[] = [];

interface QueuedBody {
  v: number;
  type: string;
  jobId: string;
  payload: Record<string, unknown>;
}

function recordingQueue() {
  const bodies: QueuedBody[] = [];
  return {
    bodies,
    binding: {
      send: async (body: unknown) => {
        bodies.push(body as QueuedBody);
      },
      sendBatch: async (list: unknown[]) => {
        for (const body of list) bodies.push(body as QueuedBody);
      },
    },
  };
}

async function postCheck(monitorId: string): Promise<Response> {
  return app.request(`/api/monitors/${monitorId}/check`, {
    method: "POST",
    headers: { Origin: LOCAL_ORIGIN, "X-Dev-Access-Email": "jo@morabeza.cv" },
  }, testDb.env);
}

async function stateRow(monitorId: string): Promise<Record<string, unknown>> {
  const row = await testDb.d1
    .prepare("SELECT * FROM monitor_state WHERE monitor_id = ?")
    .bind(monitorId)
    .first<Record<string, unknown>>();
  expect(row).not.toBeNull();
  return row as Record<string, unknown>;
}

beforeAll(async () => {
  const queue = recordingQueue();
  queuedBodies = queue.bodies;
  testDb = await createTestDb({ CHECK_QUEUE: queue.binding } as never);

  const db = getDb(testDb.env);
  await db.insert(monitors).values([
    {
      id: "mon_manual",
      clientId: "cli_morabeza",
      name: "Manual Fixture",
      url: URL,
      timeoutMs: 100,
      nextCheckAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "mon_downbound",
      clientId: "cli_morabeza",
      name: "Down-bound Fixture",
      url: URL,
      timeoutMs: 100,
      nextCheckAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  // DOWN-bound: threshold already crossed and recorded in state.
  await db.insert(monitorState).values({
    monitorId: "mon_downbound",
    status: "down",
    consecutiveFailures: 3,
    failureSequenceStartedAt: NOW,
    stateVersion: 7,
    lastEvaluatedScheduledFor: NOW,
    updatedAt: NOW,
  });
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("POST /api/monitors/:id/check (PRD §24)", () => {
  it("returns promptly (202, queued receipt) and enqueues a manual check with a unique id", async () => {
    const res = await postCheck("mon_manual");
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { checkId: string; status: string } };
    expect(body.data.status).toBe("queued");
    expect(body.data.checkId).toMatch(/^chk_/);

    const message = queuedBodies.find((b) => b.jobId === body.data.checkId);
    expect(message).toBeDefined();
    expect(message?.type).toBe("monitor.check");
    expect(message?.payload).toMatchObject({
      monitorId: "mon_manual",
      checkId: body.data.checkId,
      scheduledFor: null,
      source: "manual",
      affectsState: false,
    });
    // jobId === checkId → the consumer's unique-claim key is the check id.
    expect(message?.jobId).toBe(body.data.checkId);
  });

  it("throttles per-monitor floods (429 within the window)", async () => {
    const res = await postCheck("mon_manual");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { category: string } };
    expect(body.error.category).toBe("rate_limited");
  });

  it("a later accepted invocation gets a DIFFERENT unique check id", async () => {
    // Roll the throttle window back so the invocation is accepted again.
    await testDb.d1
      .prepare("UPDATE audit_events SET created_at = ? WHERE action = 'monitor.manual_check'")
      .bind(new Date(Date.now() - 60_000).toISOString())
      .run();

    const before = queuedBodies.length;
    const res = await postCheck("mon_manual");
    expect(res.status).toBe(202);
    const { checkId } = ((await res.json()) as { data: { checkId: string } }).data;
    expect(checkId).toMatch(/^chk_/);
    expect(queuedBodies).toHaveLength(before + 1);
  });

  it("rejects archived and disabled monitors without enqueueing", async () => {
    const db = getDb(testDb.env);
    const before = queuedBodies.length;

    await db.update(monitors).set({ enabled: 0, updatedAt: NOW }).where(eq(monitors.id, "mon_manual"));
    const disabled = await postCheck("mon_manual");
    expect(disabled.status).toBe(409);

    await db
      .update(monitors)
      .set({ enabled: 1, archivedAt: NOW, updatedAt: NOW })
      .where(eq(monitors.id, "mon_manual"));
    const archived = await postCheck("mon_manual");
    expect(archived.status).toBe(409);

    await db.update(monitors).set({ archivedAt: null, updatedAt: NOW }).where(eq(monitors.id, "mon_manual"));
    expect(queuedBodies).toHaveLength(before); // nothing enqueued by the rejections
  });

  it("rejects unknown monitors (404)", async () => {
    const res = await postCheck("mon_missing");
    expect(res.status).toBe(404);
  });

  it("writes an audit event per accepted invocation", async () => {
    const row = await testDb.d1
      .prepare("SELECT actor_email, action, entity_id, metadata_json FROM audit_events WHERE action = 'monitor.manual_check' ORDER BY created_at DESC LIMIT 1")
      .first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    expect(row?.action).toBe("monitor.manual_check");
    expect(row?.entity_id).toBe("mon_manual");
    expect(String(row?.metadata_json)).toContain("chk_");
  });
});

describe("consumer path honors source=manual (PRD §13)", () => {
  it("failing manual check on a DOWN-bound fixture: result persisted, state untouched, no notifications", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const consumer = createQueueConsumer({ checkerDeps: { fetchImpl: fetchMock } });

    const before = await stateRow("mon_downbound");

    const message: MessageLike = {
      id: "msg_manual_down",
      body: {
        v: 1,
        type: "monitor.check",
        jobId: "chk_manual_downbound",
        payload: {
          monitorId: "mon_downbound",
          checkId: "chk_manual_downbound",
          scheduledFor: null,
          source: "manual",
          affectsState: false,
        },
      },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumer({ queue: QUEUE_NAMES.checks, messages: [message] } as BatchLike, testDb.env);

    expect(message.ack).toHaveBeenCalledTimes(1);

    const row = await testDb.d1
      .prepare("SELECT * FROM check_results WHERE id = 'chk_manual_downbound'")
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      monitor_id: "mon_downbound",
      source: "manual",
      scheduled_for: null,
      is_healthy: 0,
      affects_state: 0,
      maintenance_excluded: 0,
      status_code: 500,
    });

    const after = await stateRow("mon_downbound");
    expect(after).toEqual(before); // no counter change, no status change, no version bump

    const notifications = await testDb.d1
      .prepare("SELECT COUNT(*) AS n FROM notification_events WHERE monitor_id = 'mon_downbound'")
      .first<{ n: number }>();
    expect(notifications?.n).toBe(0);
  });
});
