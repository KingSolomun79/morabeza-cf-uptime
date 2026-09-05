/**
 * Issue #13 — incident lifecycle wired into the check pipeline (PRD §12.3,
 * §17.5, §37.2): DOWN opens exactly one incident with the true failure-sequence
 * start, recovery resolves it with a real duration, duplicates never duplicate
 * (§37.2), unknown→up stays incident-free (§12.5), and the #5 disable path
 * still closes open incidents as closed_admin. Real D1 via miniflare; the
 * DEFAULT transition pipeline runs (no listener injection) so the wiring in
 * monitor-check.ts is exercised end-to-end.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { disposeTestDb, createTestDb, type TestD1 } from "../helpers/d1";
import { QUEUE_NAMES } from "../../worker/queue/schemas";
import {
  createQueueConsumer,
  type BatchLike,
  type MessageLike,
} from "../../worker/queue/consumer";
import { handleIncidentLifecycle } from "../../worker/services/incidents";
import type { StateTransitionEvent } from "../../worker/services/state-evaluation";
import { updateMonitor } from "../../worker/repositories/monitors";
import { getDb } from "../../worker/lib/db";
import { monitors, monitorState } from "../../db/schema";

const NOW = "2026-09-05T12:00:00.000Z";

// Minute slots (PRD §15.4). The file shares one D1: check ids are
// `${monitorId}:${slot}`, so distinct monitors may reuse ranges, but a
// monitor's slots must be unique per test (gotcha 7 — collisions trip #9's
// duplicate-skip instead of the code under test).
const T = (minute: number, second = 0) =>
  `2026-09-05T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

const LIFE = "mon_inc_life";
const DUPE = "mon_inc_dupe";
const UP = "mon_inc_up";
const DIS = "mon_inc_dis";
const DEDUPE = "mon_inc_372";

let testDb: TestD1;
let d1: D1Database;

function message(monitorId: string, slot: string): MessageLike {
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
      },
    },
    ack: () => {},
    retry: () => {},
  };
}

function batch(messages: MessageLike[]): BatchLike {
  return { queue: QUEUE_NAMES.checks, messages };
}

function fetchReturning(status: number): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const res = new Response(status === 200 ? "fine" : "boom", { status });
    Object.defineProperty(res, "url", { value: String(input), configurable: true });
    return res;
  }) as unknown as typeof fetch;
}

function consumerFor(healthy: boolean) {
  // No onTransition injection: the REAL default pipeline (log + incidents).
  return createQueueConsumer({ checkerDeps: { fetchImpl: fetchReturning(healthy ? 200 : 500) } });
}

async function incidentRows(monitorId: string): Promise<Record<string, unknown>[]> {
  const res = await d1
    .prepare("SELECT * FROM incidents WHERE monitor_id = ? ORDER BY opened_at")
    .bind(monitorId)
    .all<Record<string, unknown>>();
  return res.results;
}

async function stateRow(monitorId: string): Promise<Record<string, unknown>> {
  const row = await d1.prepare("SELECT * FROM monitor_state WHERE monitor_id = ?").bind(monitorId).first<Record<string, unknown>>();
  expect(row).not.toBeNull();
  return row as Record<string, unknown>;
}

function downEvent(monitorId: string, checkId: string, at: string): StateTransitionEvent {
  return {
    monitorId,
    checkId,
    transition: { type: "down", fromStatus: "up", toStatus: "down", failureSequenceStartedAt: at },
    triggerScheduledFor: at,
    at,
    stateVersion: 1,
    reasonCode: "unexpected_status",
  };
}

function recoveredEvent(monitorId: string, checkId: string, at: string): StateTransitionEvent {
  return {
    monitorId,
    checkId,
    transition: { type: "recovered", fromStatus: "down", toStatus: "up", failureSequenceStartedAt: null },
    triggerScheduledFor: at,
    at,
    stateVersion: 2,
    reasonCode: "ok",
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const UP_EVENT: StateTransitionEvent = {
  monitorId: UP,
  checkId: `${UP}:direct-up`,
  transition: { type: "up", fromStatus: "unknown", toStatus: "up", failureSequenceStartedAt: null },
  triggerScheduledFor: T(22),
  at: T(22),
  stateVersion: 1,
  reasonCode: "ok",
};

beforeAll(async () => {
  testDb = await createTestDb();
  d1 = testDb.d1;
  const db = getDb(testDb.env);
  for (const id of [LIFE, DUPE, UP, DIS, DEDUPE]) {
    await db.insert(monitors).values({
      id,
      clientId: "cli_morabeza",
      name: `Incident fixture ${id}`,
      url: "https://target.example.com/health",
      timeoutMs: 100,
      nextCheckAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      // defaults: failureThreshold 3, recoveryThreshold 2
    });
    await db.insert(monitorState).values({ monitorId: id, status: "unknown", stateVersion: 0, updatedAt: NOW });
  }
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("pipeline → incident lifecycle (default listeners)", () => {
  it("DOWN opens exactly one incident with the qualifying sequence start; recovery resolves it with duration", async () => {
    // 3 failures = threshold 3 crossing at the third slot.
    await consumerFor(false)(batch([message(LIFE, T(1)), message(LIFE, T(2)), message(LIFE, T(3))]), testDb.env);

    const open = await incidentRows(LIFE);
    expect(open).toHaveLength(1);
    const first = open[0];
    expect(first.status).toBe("open");
    expect(first.trigger_check_id).toBe(`${LIFE}:${T(3)}`);
    expect(first.open_reason_code).toBe("unexpected_status");
    // first_failure_at = start of the qualifying failure sequence (real
    // completed_at wall clock of the first failure — a valid ISO before now).
    expect(String(first.first_failure_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(first.resolved_at).toBeNull();
    expect(await stateRow(LIFE)).toMatchObject({ open_incident_id: first.id, status: "down" });

    // Recovery needs 2 consecutive successes (recoveryThreshold 2).
    await sleep(20); // guarantee a measurable outage duration (ms clock)
    await consumerFor(true)(batch([message(LIFE, T(4)), message(LIFE, T(5))]), testDb.env);

    const [resolved] = await incidentRows(LIFE);
    expect(resolved.status).toBe("resolved");
    expect(resolved.recovery_check_id).toBe(`${LIFE}:${T(5)}`);
    expect(resolved.resolution_reason).toBe("recovered");
    expect(Number(resolved.outage_duration_ms)).toBeGreaterThan(0);
    expect(resolved.resolved_at).not.toBeNull();
    expect(await stateRow(LIFE)).toMatchObject({ open_incident_id: null, status: "up" });
  });

  it("continued DOWN crossings never open a second incident; duplicate listener invocation no-ops", async () => {
    // Crossing at the third failure; a fourth failure re-applies diagnostics
    // with NO transition — and even a transition would dedupe at the index.
    await consumerFor(false)(batch([message(DUPE, T(11)), message(DUPE, T(12)), message(DUPE, T(13)), message(DUPE, T(14))]), testDb.env);
    expect(await incidentRows(DUPE)).toHaveLength(1);

    // Replay the SAME down event straight into the listener twice (§37.2
    // shape): the partial unique index makes both inserts no-ops.
    const event = downEvent(DUPE, `${DUPE}:${T(13)}`, T(13));
    await handleIncidentLifecycle(getDb(testDb.env), event);
    await handleIncidentLifecycle(getDb(testDb.env), event);

    const rows = await incidentRows(DUPE);
    expect(rows).toHaveLength(1);
    // The pointer still names the ORIGINAL incident, not a new one.
    expect(await stateRow(DUPE)).toMatchObject({ open_incident_id: rows[0].id });
  });

  it("unknown→up emits no incidents (§12.5), including a direct `up` listener call", async () => {
    await consumerFor(true)(batch([message(UP, T(21))]), testDb.env);

    expect(await stateRow(UP)).toMatchObject({ status: "up" });
    expect(await incidentRows(UP)).toHaveLength(0);

    await handleIncidentLifecycle(
      getDb(testDb.env),
      UP_EVENT,
    );
    expect(await incidentRows(UP)).toHaveLength(0);
  });

  it("disabling a monitor with an open incident still closes it closed_admin (#5 regression)", async () => {
    await consumerFor(false)(batch([message(DIS, T(31)), message(DIS, T(32)), message(DIS, T(33))]), testDb.env);
    const [open] = await incidentRows(DIS);
    expect(open.status).toBe("open");

    await updateMonitor(testDb.env, DIS, { enabled: false });

    const [closed] = await incidentRows(DIS);
    expect(closed.id).toBe(open.id);
    expect(closed.status).toBe("closed_admin");
    expect(closed.resolution_reason).toBe("monitor_disabled");
    expect(Number(closed.outage_duration_ms)).toBeGreaterThan(0);
    expect(await stateRow(DIS)).toMatchObject({ open_incident_id: null, status: "paused" });
  });
});

describe("§37.2 — duplicate state-transition execution does not duplicate incidents", () => {
  it("concurrent duplicate DOWN claims resolve to one open incident; double recovery resolves once", async () => {
    const db = getDb(testDb.env);
    const down = downEvent(DEDUPE, `${DEDUPE}:race`, "2026-09-05T10:00:00.000Z");

    // Two workers race the claim (e.g. interleaved seam deliveries).
    await Promise.all([handleIncidentLifecycle(db, down), handleIncidentLifecycle(db, down)]);

    const rows = await incidentRows(DEDUPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("open");
    expect(rows[0].first_failure_at).toBe("2026-09-05T10:00:00.000Z");
    expect(await stateRow(DEDUPE)).toMatchObject({ open_incident_id: rows[0].id });

    // One minute of outage, delivered twice — the second resolve must no-op.
    const up = recoveredEvent(DEDUPE, `${DEDUPE}:race-up`, "2026-09-05T10:01:00.000Z");
    await Promise.all([handleIncidentLifecycle(db, up), handleIncidentLifecycle(db, up)]);

    const [resolved] = await incidentRows(DEDUPE);
    expect(resolved.status).toBe("resolved");
    expect(Number(resolved.outage_duration_ms)).toBe(60_000);
    expect(await stateRow(DEDUPE)).toMatchObject({ open_incident_id: null });
  });

  it("a recovery with no open incident is a safe no-op", async () => {
    const db = getDb(testDb.env);
    await handleIncidentLifecycle(db, recoveredEvent(LIFE, `${LIFE}:no-open`, "2026-09-05T10:02:00.000Z"));
    expect(await incidentRows(LIFE)).toHaveLength(1); // untouched resolved row from the lifecycle test
  });
});
