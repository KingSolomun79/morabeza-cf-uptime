/**
 * Issue #8 — queue infrastructure tests (PRD §16, §37):
 * envelope validation, per-message batch isolation, heartbeat freshness,
 * duplicate-job idempotency hook, and DLQ persistence.
 * Runs against real D1 via miniflare.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { disposeTestDb, createTestDb, type TestD1 } from "../helpers/d1";
import { parseEnvelope, PAYLOAD_SCHEMAS, QUEUE_NAMES, envelopeSchema } from "../../worker/queue/schemas";
import { QueueProducer } from "../../worker/queue/producer";
import {
  createQueueConsumer,
  defaultRegistry,
  type BatchLike,
  type JobHandlerMap,
  type MessageLike,
} from "../../worker/queue/consumer";
import { handleDeadLetterBatch } from "../../worker/queue/dlq-consumer";
import { claimUniqueRow } from "../../worker/queue/idempotency";
import { getSystemState } from "../../worker/repositories/system";
import { checkResults } from "../../db/schema";

let testDb: TestD1;

beforeAll(async () => {
  testDb = await createTestDb();
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

// ---------------------------------------------------------------------------
// Test doubles for the Queues runtime API

function fakeMessage(body: unknown): MessageLike {
  // vi.fn() instances satisfy the method shapes at runtime; assertions read
  // the recorded calls through expect().
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function fakeBatch(queue: string, messages: MessageLike[]): BatchLike {
  return { queue, messages };
}

// ---------------------------------------------------------------------------

describe("envelope schemas (PRD §16.2)", () => {
  it("accepts a valid envelope and rejects unknown types / bad versions / missing job ids", () => {
    const valid = parseEnvelope({
      v: 1,
      type: "monitor.check",
      jobId: "mon_1:2026-09-05T12:31:00Z",
      payload: {
        monitorId: "mon_1",
        checkId: "mon_1:2026-09-05T12:31:00Z",
        scheduledFor: "2026-09-05T12:31:00Z",
        source: "scheduled",
        affectsState: true,
      },
    });
    expect(valid.type).toBe("monitor.check");

    expect(() => parseEnvelope({ v: 1, type: "mystery.type", jobId: "j", payload: {} })).toThrow();
    expect(() => parseEnvelope({ v: 2, type: "system.heartbeat", jobId: "j", payload: {} })).toThrow();
    expect(() => parseEnvelope({ v: 1, type: "system.heartbeat", payload: {} })).toThrow();
  });

  it("validates per-type payloads", () => {
    const badCheck = PAYLOAD_SCHEMAS["monitor.check"].safeParse({ monitorId: "mon_1" });
    expect(badCheck.success).toBe(false);

    const goodNotify = PAYLOAD_SCHEMAS["notification.send"].safeParse({ notificationEventId: "evt_1" });
    expect(goodNotify.success).toBe(true);

    const parse = envelopeSchema.safeParse({ v: 1, type: "system.heartbeat", jobId: "hb:slot", payload: {} });
    expect(parse.success).toBe(true);
  });
});

describe("producer", () => {
  it("validates payloads before enqueueing and forwards wrapped envelopes", async () => {
    const sent: unknown[] = [];
    const producer = new QueueProducer({
      send: async (body) => {
        sent.push(body);
      },
      sendBatch: async () => undefined,
    });

    await producer.send({
      type: "system.heartbeat",
      jobId: "hb:2026-09-05T12:35:00Z",
      payload: {},
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ v: 1, type: "system.heartbeat", jobId: "hb:2026-09-05T12:35:00Z" });

    await expect(
      producer.send({
        type: "monitor.check",
        jobId: "mon_1:slot",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: { monitorId: "mon_1" } as any, // missing required fields
      }),
    ).rejects.toThrow(/refusing to enqueue/);
    expect(sent).toHaveLength(1); // nothing entered the queue
  });
});

describe("consumer batch semantics (PRD §37.9)", () => {
  it("acks successes and retries failures without losing the rest of the batch", async () => {
    const { env } = testDb;
    const consumer = createQueueConsumer();

    const ok = fakeMessage({ v: 1, type: "system.heartbeat", jobId: "hb:1", payload: {} });
    const invalid = fakeMessage({ not: "an envelope" });
    const unknownType = fakeMessage({ v: 1, type: "mystery.type", jobId: "j2", payload: {} });
    const badPayload = fakeMessage({
      v: 1,
      type: "monitor.check",
      jobId: "j3",
      payload: { monitorId: "mon_1" },
    });

    await consumer(fakeBatch(QUEUE_NAMES.checks, [ok, invalid, unknownType, badPayload]), env);

    expect(ok.ack).toHaveBeenCalledTimes(1);
    for (const message of [invalid, unknownType, badPayload]) {
      expect(message.retry).toHaveBeenCalledTimes(1);
      expect(message.ack).not.toHaveBeenCalled();
    }
  });

  it("refreshes last_queue_consumer_at from real batch work (PRD §19)", async () => {
    const { env } = testDb;
    const consumer = createQueueConsumer();

    await consumer(
      fakeBatch(QUEUE_NAMES.checks, [fakeMessage({ v: 1, type: "system.heartbeat", jobId: `hb:${Date.now()}`, payload: {} })]),
      env,
    );

    const state = await getSystemState(env);
    expect(state?.lastQueueConsumerAt).not.toBeNull();
    expect(new Date(state?.lastQueueConsumerAt as string).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("default registry fails loudly for not-yet-implemented job types", async () => {
    const { env } = testDb;
    const consumer = createQueueConsumer();

    const future = fakeMessage({
      v: 1,
      type: "rollup.hourly",
      jobId: "rollup:2026-09-05T11:00:00Z",
      payload: { hourStart: "2026-09-05T11:00:00Z" },
    });

    await consumer(fakeBatch(QUEUE_NAMES.checks, [future]), env);
    expect(future.retry).toHaveBeenCalledTimes(1); // → DLQ after max_retries
  });
});

describe("infra-level idempotency hook (PRD §16.4)", () => {
  const MONITOR_SQL =
    "INSERT INTO monitors (id, client_id, name, url, next_check_at, created_at, updated_at) VALUES (?, 'cli_morabeza', 'Idem', 'https://example.com/', '2026-09-05T12:00:00Z', '2026-09-05T12:00:00Z', '2026-09-05T12:00:00Z')";
  const CLAIM_VALUES = (monitorId: string, checkId: string) => ({
    id: checkId,
    monitorId,
    source: "scheduled",
    startedAt: "2026-09-05T12:31:00Z",
    completedAt: "2026-09-05T12:31:01Z",
    isHealthy: 1,
    reasonCode: "ok",
    createdAt: "2026-09-05T12:31:01Z",
  });

  it("claimUniqueRow returns true on first delivery and false for duplicates", async () => {
    const { env, d1 } = testDb;
    await d1.prepare(MONITOR_SQL).bind("mon_idem").run();
    const values = CLAIM_VALUES("mon_idem", "check:first-delivery");

    const first = await claimUniqueRow(env, checkResults, values);
    expect(first).toBe(true);

    const duplicate = await claimUniqueRow(env, checkResults, values);
    expect(duplicate).toBe(false);
  });

  it("delivers the same jobId twice without duplicating side effects", async () => {
    const { env, d1 } = testDb;
    await d1.prepare(MONITOR_SQL).bind("mon_dup").run();

    // A handler modeled exactly on the #9 check-handler contract: claim the
    // result row; only the claimer performs the follow-up side effect.
    let sideEffects = 0;
    const registry: JobHandlerMap = {
      ...defaultRegistry(),
      "system.heartbeat": async (_payload, ctx) => {
        const claimed = await claimUniqueRow(
          env,
          checkResults,
          CLAIM_VALUES("mon_dup", `check:${ctx.jobId}`),
        );
        if (claimed) sideEffects += 1;
      },
    };
    const consumer = createQueueConsumer(registry);

    const message1 = fakeMessage({ v: 1, type: "system.heartbeat", jobId: "job-same", payload: {} });
    const message2 = fakeMessage({ v: 1, type: "system.heartbeat", jobId: "job-same", payload: {} });
    await consumer(fakeBatch(QUEUE_NAMES.checks, [message1]), env);
    await consumer(fakeBatch(QUEUE_NAMES.checks, [message2]), env);

    expect(message1.ack).toHaveBeenCalledTimes(1);
    expect(message2.ack).toHaveBeenCalledTimes(1); // duplicate completed, not retried
    expect(sideEffects).toBe(1); // exactly one side effect across deliveries

    const rows = await d1
      .prepare("SELECT COUNT(*) AS n FROM check_results WHERE id = 'check:job-same'")
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe("DLQ consumer (PRD §16.6)", () => {
  it("records dead_letter_events and acks, with no notification side effects", async () => {
    const { env, d1 } = testDb;
    const valid = fakeMessage({
      v: 1,
      type: "monitor.check",
      jobId: "mon_1:doomed-slot",
      payload: { monitorId: "mon_1", checkId: "c", scheduledFor: null, source: "scheduled", affectsState: true },
    });
    const garbage = fakeMessage("totally not an envelope");

    await handleDeadLetterBatch(fakeBatch(QUEUE_NAMES.dlq, [valid, garbage]), env);

    expect(valid.ack).toHaveBeenCalledTimes(1);
    expect(garbage.ack).toHaveBeenCalledTimes(1);
    expect(valid.retry).not.toHaveBeenCalled();

    const rows = await d1
      .prepare("SELECT original_job_id, message_type, payload_summary_json FROM dead_letter_events ORDER BY received_at")
      .all<{ original_job_id: string | null; message_type: string | null; payload_summary_json: string }>();
    expect(rows.results).toHaveLength(2);

    const parsed = rows.results.map((row) => ({
      jobId: row.original_job_id,
      type: row.message_type,
      summary: JSON.parse(row.payload_summary_json) as { summary: string },
    }));
    expect(parsed[0]).toMatchObject({ jobId: "mon_1:doomed-slot", type: "monitor.check" });
    expect(parsed[1].jobId).toBeNull();
    expect(parsed[1].summary.summary).toContain("totally not an envelope");

    const notifications = await d1.prepare("SELECT COUNT(*) AS n FROM notification_events").first<{ n: number }>();
    expect(notifications?.n).toBe(0);
  });
});
