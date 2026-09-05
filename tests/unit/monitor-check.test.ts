/**
 * Issue #9 — monitor.check end-to-end pipeline (PRD §16.4, §20):
 * config-from-D1, idempotent result persistence, archived/disabled rejection,
 * manual-check flagging, and the #12 seam guarantees.
 * Real D1 via miniflare; outbound HTTP mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { disposeTestDb, createTestDb, type TestD1 } from "../helpers/d1";
import { QUEUE_NAMES } from "../../worker/queue/schemas";
import {
  createQueueConsumer,
  defaultRegistry,
  type BatchLike,
  type MessageLike,
} from "../../worker/queue/consumer";

const NOW_ISO = "2026-09-05T12:00:00.000Z";
const CHECK_URL = "https://target.example.com/health";

let testDb: TestD1;

function message(overrides: Record<string, unknown> = {}): MessageLike {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    body: {
      v: 1,
      type: "monitor.check",
      jobId: "mon_check:slot-1",
      payload: {
        monitorId: "mon_check",
        checkId: "mon_check:slot-1",
        scheduledFor: "slot-1",
        source: "scheduled",
        affectsState: true,
      },
      ...overrides,
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batch(messages: MessageLike[]): BatchLike {
  return { queue: QUEUE_NAMES.checks, messages };
}

function okFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const res = new Response("fine", { status: 200 });
    Object.defineProperty(res, "url", { value: String(input), configurable: true });
    return res;
  }) as unknown as typeof fetch;
}

async function resultRow(checkId: string): Promise<Record<string, unknown> | null> {
  const row = await testDb.d1.prepare("SELECT * FROM check_results WHERE id = ?").bind(checkId).first<Record<string, unknown>>();
  return row ?? null;
}

beforeAll(async () => {
  testDb = await createTestDb();
  const db = (await import("../../worker/lib/db")).getDb(testDb.env);
  await db.insert((await import("../../db/schema")).monitors).values({
    id: "mon_check",
    clientId: "cli_morabeza",
    name: "Check Fixture",
    url: CHECK_URL,
    timeoutMs: 100, // low so timeout-path tests don't wait 10s
    nextCheckAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await db.insert((await import("../../db/schema")).monitorState).values({
    monitorId: "mon_check",
    status: "unknown",
    stateVersion: 0,
    updatedAt: NOW_ISO,
  });
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("scheduled check end-to-end (PRD §16.4, §32.2)", () => {
  it("produces exactly one persisted result with correct flags", async () => {
    const { env } = testDb;
    const consumer = createQueueConsumer({ checkerDeps: { fetchImpl: okFetch() } });
    const msg = message();

    await consumer(batch([msg]), env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    const row = await resultRow("mon_check:slot-1");
    expect(row).toMatchObject({
      monitor_id: "mon_check",
      source: "scheduled",
      scheduled_for: "slot-1",
      is_healthy: 1,
      maintenance_excluded: 0,
      affects_state: 1,
      status_code: 200,
      reason_code: "ok",
      error_message: null,
      final_url: CHECK_URL,
    });
  });

  it("is idempotent: the same message twice → one row, no state side effects", async () => {
    const { env } = testDb;
    const consumer = createQueueConsumer({ checkerDeps: { fetchImpl: okFetch() } });
    const msg1 = message({ payload: { monitorId: "mon_check", checkId: "mon_check:dup", scheduledFor: "dup", source: "scheduled", affectsState: true } });
    const msg2 = message({ payload: { monitorId: "mon_check", checkId: "mon_check:dup", scheduledFor: "dup", source: "scheduled", affectsState: true } });

    await consumer(batch([msg1]), env);
    const before = await testDb.d1.prepare("SELECT status, state_version FROM monitor_state WHERE monitor_id = 'mon_check'").first();
    await consumer(batch([msg2]), env);
    const after = await testDb.d1.prepare("SELECT status, state_version FROM monitor_state WHERE monitor_id = 'mon_check'").first();

    expect(msg2.ack).toHaveBeenCalledTimes(1); // completed, not retried
    const count = await testDb.d1.prepare("SELECT COUNT(*) AS n FROM check_results WHERE id = 'mon_check:dup'").first<{ n: number }>();
    expect(count?.n).toBe(1);
    expect(after).toEqual(before); // state untouched — #12 owns transitions
  });

  it("loads configuration from D1 at execution time, not from the payload (PRD §20.1)", async () => {
    const { env, d1 } = testDb;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const res = new Response("ok", { status: 200 });
      Object.defineProperty(res, "url", { value: String(input), configurable: true });
      return res;
    }) as unknown as typeof fetch;
    const consumer = createQueueConsumer({ checkerDeps: { fetchImpl: fetchMock } });

    // "Enqueue" against the old URL, then the operator retargets the monitor.
    const oldUrl = `${CHECK_URL}/v1`;
    await d1.prepare("UPDATE monitors SET url = ? WHERE id = 'mon_check'").bind(oldUrl).run();
    const msg = message({ jobId: "mon_check:retarget", payload: { monitorId: "mon_check", checkId: "mon_check:retarget", scheduledFor: "retarget", source: "scheduled", affectsState: true } });
    await consumer(batch([msg]), env);

    await d1.prepare("UPDATE monitors SET url = ? WHERE id = 'mon_check'").bind(CHECK_URL).run();
    const msg2 = message({ jobId: "mon_check:retarget2", payload: { monitorId: "mon_check", checkId: "mon_check:retarget2", scheduledFor: "retarget2", source: "scheduled", affectsState: true } });
    await consumer(batch([msg2]), env);

    const firstCall = String((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    const secondCall = String((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]);
    expect(firstCall).toContain("/v1");
    expect(secondCall).toContain(CHECK_URL);
  });

  it("rejects archived monitors and missing monitors without executing checks", async () => {
    const { env, d1 } = testDb;
    const fetchMock = okFetch();
    const consumer = createQueueConsumer({ checkerDeps: { fetchImpl: fetchMock } });

    await d1.prepare("UPDATE monitors SET archived_at = '2026-09-05T13:00:00Z' WHERE id = 'mon_check'").run();
    const archived = message({ jobId: "mon_check:arch", payload: { monitorId: "mon_check", checkId: "mon_check:arch", scheduledFor: "arch", source: "scheduled", affectsState: true } });
    const missing = message({ jobId: "mon_gone:x", payload: { monitorId: "mon_gone", checkId: "mon_gone:x", scheduledFor: "x", source: "scheduled", affectsState: true } });

    await consumer(batch([archived, missing]), env);

    expect(archived.ack).toHaveBeenCalledTimes(1);
    expect(missing.ack).toHaveBeenCalledTimes(1);
    expect(await resultRow("mon_check:arch")).toBeNull();
    expect(await resultRow("mon_gone:x")).toBeNull();
    expect((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

    await d1.prepare("UPDATE monitors SET archived_at = NULL WHERE id = 'mon_check'").run();
  });

  it("disabled monitors no-op for scheduled work but run for manual diagnostics", async () => {
    const { env, d1 } = testDb;
    const fetchMock = okFetch();
    const consumer = createQueueConsumer({ checkerDeps: { fetchImpl: fetchMock } });

    await d1.prepare("UPDATE monitors SET enabled = 0 WHERE id = 'mon_check'").run();

    const scheduled = message({ jobId: "mon_check:off", payload: { monitorId: "mon_check", checkId: "mon_check:off", scheduledFor: "off", source: "scheduled", affectsState: true } });
    const manual = message({ jobId: "mon_check:manual-off", payload: { monitorId: "mon_check", checkId: "mon_check:manual-off", scheduledFor: null, source: "manual", affectsState: false } });
    await consumer(batch([scheduled, manual]), env);

    expect(scheduled.ack).toHaveBeenCalledTimes(1);
    expect(await resultRow("mon_check:off")).toBeNull();
    const manualRow = await resultRow("mon_check:manual-off");
    expect(manualRow).toMatchObject({ source: "manual", affects_state: 0 });

    await d1.prepare("UPDATE monitors SET enabled = 1 WHERE id = 'mon_check'").run();
  });

  it("persists sanitized diagnostics only — no response body ever reaches D1", async () => {
    const { env } = testDb;
    const marker = "TOP-SECRET-BODY-MARKER";
    const fetchMock = vi.fn(async () => new Response(`${"x".repeat(400)}${marker}`, { status: 200 })) as unknown as typeof fetch;
    const consumer = createQueueConsumer({ checkerDeps: { fetchImpl: fetchMock } });

    const msg = message({ jobId: "mon_check:body", payload: { monitorId: "mon_check", checkId: "mon_check:body", scheduledFor: "body", source: "scheduled", affectsState: true } });
    await consumer(batch([msg]), env);

    const row = await resultRow("mon_check:body");
    expect(JSON.stringify(row)).not.toContain(marker);
    expect(row?.assertions_json).toBeNull(); // no body assertions configured
  });

  it("classifies failures: unexpected status and timeout with sanitized errors", async () => {
    const { env } = testDb;
    const failing = vi.fn(async () => new Response("server error", { status: 500 })) as unknown as typeof fetch;
    const consumer = createQueueConsumer({ checkerDeps: { fetchImpl: failing } });

    const msg = message({ jobId: "mon_check:fail", payload: { monitorId: "mon_check", checkId: "mon_check:fail", scheduledFor: "fail", source: "scheduled", affectsState: true } });
    await consumer(batch([msg]), env);

    const row = await resultRow("mon_check:fail");
    expect(row).toMatchObject({ is_healthy: 0, reason_code: "unexpected_status", status_code: 500 });
    const assertions = JSON.parse(row?.assertions_json as string) as { status?: { actual: number } };
    expect(assertions.status?.actual).toBe(500);

    const timingOut = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ) as unknown as typeof fetch;
    const consumer2 = createQueueConsumer({ checkerDeps: { fetchImpl: timingOut } });
    const msg2 = message({ jobId: "mon_check:slow", payload: { monitorId: "mon_check", checkId: "mon_check:slow", scheduledFor: "slow", source: "scheduled", affectsState: true } });
    await consumer2(batch([msg2]), env);

    const slowRow = await resultRow("mon_check:slow");
    expect(slowRow).toMatchObject({ is_healthy: 0, reason_code: "timeout" });
  });

  it("works through the default registry path with injected checker deps", async () => {
    const { env } = testDb;
    const consumer = createQueueConsumer({ registry: defaultRegistry({ fetchImpl: okFetch() }) });

    const msg = message({ jobId: "mon_check:default-reg", payload: { monitorId: "mon_check", checkId: "mon_check:default-reg", scheduledFor: "default-reg", source: "scheduled", affectsState: true } });
    await consumer(batch([msg]), env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(await resultRow("mon_check:default-reg")).not.toBeNull();
  });
});
