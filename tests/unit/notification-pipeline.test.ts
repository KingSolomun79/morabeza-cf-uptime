/**
 * Issue #17 — email pipeline (PRD §9, §16.4 steps 6–7, §32.1 notifications
 * matrix, §37.3/§37.5): transition → deduped intent rows → queued sends with
 * retries; test-email endpoint independent of incidents. Real D1 via
 * miniflare; the EMAIL binding is faked (never real email) and CHECK_QUEUE is
 * a recording fake so enqueue → consume is observable end-to-end.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { disposeTestDb, createTestDb, LOCAL_ORIGIN, type TestD1 } from "../helpers/d1";
import app from "../../worker/app";
import { getDb } from "../../worker/lib/db";
import {
  auditEvents,
  clients,
  incidents,
  maintenanceWindows,
  monitorNotificationTargets,
  monitors,
  monitorState,
  notificationEvents,
  notificationTargets,
} from "../../db/schema";
import { QUEUE_NAMES } from "../../worker/queue/schemas";
import {
  createQueueConsumer,
  type BatchLike,
  type MessageLike,
} from "../../worker/queue/consumer";
import { handleNotificationIntents } from "../../worker/services/notifications";
import type { SendEmailPort } from "../../worker/services/notifications";
import type { StateTransitionEvent } from "../../worker/services/state-evaluation";

const NOW = "2026-09-05T12:00:00.000Z";
const T = (minute: number, second = 0) =>
  `2026-09-05T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

const MAP = "mon_ntf_map"; // explicit mappings: tgt_mapped (enabled) + tgt_disabled_map
const DEF = "mon_ntf_def"; // no mappings → is_default fallback
const UP = "mon_ntf_up"; // unknown→up must stay silent; later the loud-failure fixture
const MAINT = "mon_ntf_maint"; // maintenance-excluded checks
const MANUAL = "mon_ntf_manual"; // manual diagnostics

const URL = "https://target.example.com/health";
const FROM = "Morabeza Alerts <alerts@morabeza.digital>";

// ── fakes (never real email, §9 local/test transport) ──────────────────────
// Shared mutable fake state across the file mirrors the shared-D1-per-file
// convention (HANDOFF gotcha 7): tests run in order and may depend on rows
// from earlier lifecycle steps. `failuresRemaining` must be 0 unless a test
// sets it explicitly.
const fakeQueue = {
  sent: [] as unknown[],
  send: async (body: unknown) => {
    fakeQueue.sent.push(body);
  },
  sendBatch: async (bodies: unknown[]) => {
    fakeQueue.sent.push(...bodies);
  },
};

const sendCalls: Array<{ from: string; to: string; subject: string; text: string }> = [];
let failuresRemaining = 0;
const fakeSender: SendEmailPort = async (message) => {
  if (failuresRemaining > 0) {
    failuresRemaining -= 1;
    throw new Error("smtp boom");
  }
  sendCalls.push({ ...message });
  return { messageId: `mock-${sendCalls.length}` };
};

let testDb: TestD1;

function checkConsumer(healthy: boolean) {
  return createQueueConsumer({
    checkerDeps: {
      fetchImpl: (async () => new Response(healthy ? "fine" : "boom", { status: healthy ? 200 : 500 })) as unknown as typeof fetch,
    },
  });
}
const sendConsumer = () => createQueueConsumer({ notificationDeps: { sendEmail: fakeSender } });
const defaultConsumer = () => createQueueConsumer(); // default sender → env.EMAIL (absent here) fails loudly

function batch(messages: MessageLike[]): BatchLike {
  return { queue: QUEUE_NAMES.checks, messages };
}

function message(monitorId: string, slot: string, overrides: Record<string, unknown> = {}): MessageLike {
  return {
    id: `msg_${monitorId}_${slot}`,
    body: {
      v: 1,
      type: "monitor.check",
      jobId: `${monitorId}:${slot}`,
      payload: {
        monitorId,
        checkId: `${monitorId}:${slot}`,
        scheduledFor: slot,
        source: "scheduled",
        affectsState: true,
        ...overrides,
      },
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

/** Moves recorded queue envelopes into MessageLikes, clears the queue, processes. */
async function drainQueueWith(consumer: ReturnType<typeof createQueueConsumer>): Promise<MessageLike[]> {
  // send() records the envelope; sendBatch records Cloudflare's { body } wrap.
  const messages: MessageLike[] = fakeQueue.sent.map((rec, i) => ({
    id: `drain_${i}`,
    body: (rec as { body?: unknown }).body ?? rec,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  fakeQueue.sent.length = 0;
  if (messages.length > 0) {
    await consumer(batch(messages), testDb.env);
  }
  return messages;
}

async function eventById(id: string) {
  const [row] = await getDb(testDb.env)
    .select()
    .from(notificationEvents)
    .where(eq(notificationEvents.id, id));
  return row ?? null;
}

async function eventsFor(monitorId: string | null, targetId?: string) {
  const rows = await getDb(testDb.env).select().from(notificationEvents);
  return rows.filter(
    (r) =>
      (monitorId === null ? r.monitorId === null : r.monitorId === monitorId) &&
      (targetId ? r.targetId === targetId : true),
  );
}

beforeAll(async () => {
  testDb = await createTestDb({
    CHECK_QUEUE: fakeQueue as unknown as Queue,
    DEFAULT_FROM_EMAIL: FROM,
  });
  const db = getDb(testDb.env);

  for (const id of [MAP, DEF, UP, MAINT, MANUAL]) {
    await db.insert(monitors).values({
      id,
      clientId: "cli_morabeza",
      name: `Notify ${id}`,
      url: URL,
      timeoutMs: 100,
      nextCheckAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(monitorState).values({ monitorId: id, status: "unknown", stateVersion: 0, updatedAt: NOW });
  }

  await db.insert(notificationTargets).values([
    { id: "tgt_mapped", name: "Mapped ops", email: "mapped@morabeza.digital", enabled: 1, isDefault: 0, createdAt: NOW, updatedAt: NOW },
    { id: "tgt_disabled_map", name: "Disabled mapping", email: "disabled.map@morabeza.digital", enabled: 0, isDefault: 0, createdAt: NOW, updatedAt: NOW },
    { id: "tgt_default", name: "Default ops", email: "default@morabeza.digital", enabled: 1, isDefault: 1, createdAt: NOW, updatedAt: NOW },
    { id: "tgt_disabled_default", name: "Disabled default", email: "disabled.default@morabeza.digital", enabled: 0, isDefault: 1, createdAt: NOW, updatedAt: NOW },
    { id: "tgt_unrelated", name: "Unrelated", email: "unrelated@morabeza.digital", enabled: 1, isDefault: 0, createdAt: NOW, updatedAt: NOW },
  ]);
  await db.insert(monitorNotificationTargets).values([
    { monitorId: MAP, targetId: "tgt_mapped" },
    { monitorId: MAP, targetId: "tgt_disabled_map" },
  ]);

  // Subject labels come from the client name (PRD §9.4: "[DOWN] client — monitor").
  const [clientRow] = await db.select().from(clients).where(eq(clients.id, "cli_morabeza"));
  expect(clientRow.name).toBe("Morabeza");
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("transition → intents → queued sends (§9.6 lifecycle, §32.1 matrix)", () => {
  it("DOWN: one pending event per resolved target, one send per event — never per failed check", async () => {
    // 4 failing checks but only the threshold crossing (3rd) emits an intent.
    await checkConsumer(false)(batch([message(MAP, T(1)), message(MAP, T(2)), message(MAP, T(3)), message(MAP, T(4))]), testDb.env);

    const events = await eventsFor(MAP);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.targetId).toBe("tgt_mapped"); // explicit mapping, enabled
    expect(event.type).toBe("down");
    expect(event.status).toBe("pending");

    const [incident] = await getDb(testDb.env).select().from(incidents).where(eq(incidents.monitorId, MAP));
    expect(event.incidentId).toBe(incident.id);
    expect(event.dedupeKey).toBe(`${incident.id}:down:tgt_mapped`);

    // Exactly one queued job, deterministically keyed by the event row id.
    expect(fakeQueue.sent).toHaveLength(1);
    const recorded = fakeQueue.sent[0] as { body?: unknown };
    const envelope = ((recorded.body ?? recorded) as { type: string; jobId: string; payload: { notificationEventId: string } });
    expect(envelope).toMatchObject({ type: "notification.send", jobId: event.id, payload: { notificationEventId: event.id } });

    // Process the send job: §9.4 fields, configurable sender, row → sent.
    const [job] = await drainQueueWith(sendConsumer());
    expect(job?.ack).toHaveBeenCalled();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].to).toBe("mapped@morabeza.digital");
    expect(sendCalls[0].from).toBe(FROM);
    expect(sendCalls[0].subject).toBe(`[DOWN] 🔴 Morabeza — Notify ${MAP}`);
    // Owner-requested status emoji (#29): body leads with the 🔴 DOWN marker.
    expect(sendCalls[0].text).toContain(`🔴 DOWN — Morabeza / Notify ${MAP} is down.`);
    expect(sendCalls[0].text).toContain(`URL: ${URL}`);
    expect(sendCalls[0].text).toContain("Failure reason: unexpected_status");
    expect(sendCalls[0].text).toContain("HTTP status: 500");
    expect(sendCalls[0].text).toContain("Response time:");
    // By send time a 4th failure has been counted (continued failures keep
    // counting after the crossing) — §9.4 asks for the current count.
    expect(sendCalls[0].text).toContain("Consecutive failures: 4");
    expect(sendCalls[0].text).toContain(`Incident opened at: ${incident.openedAt}`);
    expect(sendCalls[0].text).toContain(`${LOCAL_ORIGIN}/monitors/${MAP}`);

    const sent = await eventById(event.id);
    expect(sent?.status).toBe("sent");
    expect(sent?.providerMessageId).toBe("mock-1");
    expect(sent?.sentAt).not.toBeNull();
    expect(sent?.attempts).toBe(0);

    // Disabled mapping and unmapped non-default targets never get events (§17.8).
    expect(await eventsFor(MAP, "tgt_disabled_map")).toHaveLength(0);
    expect(await eventsFor(null, "tgt_unrelated")).toHaveLength(0);
  });

  it("duplicate intent creation for the same transition is inert (§37.3)", async () => {
    const rowsBefore = (await eventsFor(MAP)).length;
    const queueBefore = fakeQueue.sent.length;

    const replay: StateTransitionEvent = {
      monitorId: MAP,
      checkId: `${MAP}:${T(3)}`,
      transition: { type: "down", fromStatus: "up", toStatus: "down", failureSequenceStartedAt: T(1) },
      triggerScheduledFor: T(3),
      at: T(3),
      stateVersion: 3,
      reasonCode: "unexpected_status",
    };
    await handleNotificationIntents(testDb.env, replay);
    await handleNotificationIntents(testDb.env, replay);

    expect(await eventsFor(MAP)).toHaveLength(rowsBefore);
    expect(fakeQueue.sent).toHaveLength(queueBefore);
  });

  it("RECOVERED: one event per target referencing the incident, with §9.5 fields", async () => {
    await checkConsumer(true)(batch([message(MAP, T(5)), message(MAP, T(6))]), testDb.env);

    const db = getDb(testDb.env);
    const recovered = (await eventsFor(MAP, "tgt_mapped")).filter((e) => e.type === "recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe("pending");
    const incidentId = recovered[0].incidentId;
    expect(incidentId).not.toBeNull();

    const [incident] = await db.select().from(incidents).where(eq(incidents.id, incidentId as string));
    expect(incident.status).toBe("resolved");
    expect(recovered[0].dedupeKey).toBe(`${incident.id}:recovered:tgt_mapped`);
    expect(fakeQueue.sent).toHaveLength(1);

    const sendsBefore = sendCalls.length;
    await drainQueueWith(sendConsumer());
    expect(sendCalls).toHaveLength(sendsBefore + 1);
    expect(sendCalls[sendsBefore].subject).toBe(`[RECOVERED] ✅ Morabeza — Notify ${MAP}`);
    expect(sendCalls[sendsBefore].text).toContain(`✅ RECOVERED — Morabeza / Notify ${MAP} is back up.`);
    expect(sendCalls[sendsBefore].text).toContain(`Recovered at: ${incident.resolvedAt}`);
    expect(sendCalls[sendsBefore].text).toContain("Outage duration:");
    expect(sendCalls[sendsBefore].text).toContain(`${LOCAL_ORIGIN}/incidents/${incident.id}`);

    expect((await eventById(recovered[0].id))?.status).toBe("sent");
  });

  it("unknown→up produces zero notification events (§12.5)", async () => {
    await checkConsumer(true)(batch([message(UP, T(10))]), testDb.env);
    expect(await eventsFor(UP)).toHaveLength(0);
  });

  it("manual and maintenance-excluded checks never produce events", async () => {
    const db = getDb(testDb.env);
    const now = Date.now();
    await db.insert(maintenanceWindows).values({
      id: "win_ntf",
      title: "Alert silence drill",
      scopeType: "monitor",
      scopeId: MAINT,
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      createdAt: NOW,
      updatedAt: NOW,
    });

    const failing = checkConsumer(false);
    // Manual diagnostics: affects_state=0 gate (PRD §13).
    await failing(
      batch([message(MANUAL, "manual-1", { checkId: `${MANUAL}:manual-1`, scheduledFor: null, source: "manual", affectsState: false })]),
      testDb.env,
    );
    // Scheduled checks inside a live window: maintenance exclusion (PRD §14).
    await failing(batch([message(MAINT, T(20)), message(MAINT, T(21)), message(MAINT, T(22))]), testDb.env);

    expect(await eventsFor(MANUAL)).toHaveLength(0);
    expect(await eventsFor(MAINT)).toHaveLength(0);
    const maintIncidents = await db.select().from(incidents).where(eq(incidents.monitorId, MAINT));
    expect(maintIncidents).toHaveLength(0);
  });
});

describe("default-target fallback + notification.send handler", () => {
  it("monitors without explicit mappings alert enabled defaults (§17.8)", async () => {
    await checkConsumer(false)(batch([message(DEF, T(30)), message(DEF, T(31)), message(DEF, T(32))]), testDb.env);

    const events = await eventsFor(DEF, "tgt_default");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("down");
    expect(events[0].status).toBe("pending");
  });

  it("send failure records attempts/last_error and Queue retry succeeds (§9.6)", async () => {
    failuresRemaining = 1;
    const [job] = await drainQueueWith(sendConsumer()); // first delivery fails
    expect(job?.retry).toHaveBeenCalled();

    const failed = await eventById((await eventsFor(DEF, "tgt_default"))[0].id);
    expect(failed?.status).toBe("pending");
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toBe("smtp boom");

    // Queue redelivery = the SAME message processed again (at-least-once).
    await sendConsumer()(batch([job!]), testDb.env);
    const afterRetry = await eventById(failed!.id);
    expect(afterRetry?.status).toBe("sent");
    expect(afterRetry?.attempts).toBe(1);
    expect(afterRetry?.providerMessageId).toBe(`mock-${sendCalls.length}`);
    expect(afterRetry?.sentAt).not.toBeNull();
  });

  it("duplicate notification.send job cannot double-send (§37.3)", async () => {
    const sendsBefore = sendCalls.length;
    const [event] = await eventsFor(DEF, "tgt_default");
    const duplicate: MessageLike = {
      id: "dup_1",
      body: { v: 1, type: "notification.send", jobId: event.id, payload: { notificationEventId: event.id } },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await sendConsumer()(batch([duplicate]), testDb.env);
    expect(sendCalls).toHaveLength(sendsBefore);
    expect(duplicate.ack).toHaveBeenCalled();
    expect(duplicate.retry).not.toHaveBeenCalled();
  });

  it("a missing EMAIL binding fails loudly onto the row (retry → DLQ path)", async () => {
    // UP is currently `up` (one success earlier): 3 failures cross DOWN.
    // UP has no explicit mappings → default fallback tgt_default.
    await checkConsumer(false)(batch([message(UP, T(40)), message(UP, T(41)), message(UP, T(42))]), testDb.env);
    const [event] = await eventsFor(UP, "tgt_default");
    expect(event?.status).toBe("pending");

    // Process with the DEFAULT registry: no injected sender, env.EMAIL unset.
    const [job] = await drainQueueWith(defaultConsumer());
    expect(job?.retry).toHaveBeenCalled();
    const row = await eventById(event!.id);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("EMAIL binding is not configured");
    // The retryable catch spans lookup + render + send: any throw after the
    // `sending` claim lands here — the row is back to `pending`, never
    // stranded in `sending` (the FK makes the orphaned-target terminal
    // branch unreachable, so it stays defensive-only).
  });
});

describe("POST /api/notification-targets/:id/test (PRD §24)", () => {
  async function post(path: string): Promise<Response> {
    return app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: LOCAL_ORIGIN, "X-Dev-Access-Email": "jo@morabeza.cv" },
    }, testDb.env);
  }

  it("queues and sends a test email with zero incidents involved", async () => {
    fakeQueue.sent.length = 0;
    const res = await post("/api/notification-targets/tgt_unrelated/test");
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { notificationEventId: string; queued: boolean } };
    expect(body.data.queued).toBe(true);

    const testEvent = await eventById(body.data.notificationEventId);
    expect(testEvent?.type).toBe("test");
    expect(testEvent?.monitorId).toBeNull();
    expect(testEvent?.incidentId).toBeNull();
    expect(testEvent?.dedupeKey.startsWith("tgt_unrelated:test:")).toBe(true);
    expect(fakeQueue.sent).toHaveLength(1);

    const sendsBefore = sendCalls.length;
    await drainQueueWith(sendConsumer());
    const call = sendCalls[sendsBefore];
    expect(call.to).toBe("unrelated@morabeza.digital");
    expect(call.subject).toContain("[TEST]");
    expect((await eventById(body.data.notificationEventId))?.status).toBe("sent");

    const audits = await getDb(testDb.env).select().from(auditEvents);
    expect(audits.some((a) => a.action === "notification_target.test" && a.entityId === "tgt_unrelated")).toBe(true);
  });

  it("404s for unknown targets", async () => {
    const res = await post("/api/notification-targets/tgt_nope/test");
    expect(res.status).toBe(404);
  });

  it("every test invocation sends (dedupe key unique per invocation)", async () => {
    fakeQueue.sent.length = 0;
    const r1 = await post("/api/notification-targets/tgt_unrelated/test");
    const r2 = await post("/api/notification-targets/tgt_unrelated/test");
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    const tests = (await eventsFor(null, "tgt_unrelated")).filter((e) => e.type === "test");
    expect(new Set(tests.map((e) => e.dedupeKey)).size).toBe(tests.length);
    expect(fakeQueue.sent).toHaveLength(2);
  });
});
