/**
 * Issue #12 — state evaluation through the monitor.check pipeline (PRD §12,
 * §16.4 step 5, §16.5): threshold transitions end-to-end, out-of-order
 * protection, compare-and-set under interleaved deliveries, and the
 * manual/maintenance/paused gates. Real D1 via miniflare; fetch mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { disposeTestDb, createTestDb, type TestD1 } from "../helpers/d1";
import { QUEUE_NAMES } from "../../worker/queue/schemas";
import {
  createQueueConsumer,
  type BatchLike,
  type MessageLike,
} from "../../worker/queue/consumer";
import { evaluateCheckAgainstState, type StateTransitionEvent } from "../../worker/services/state-evaluation";
import type { TransitionListener } from "../../worker/services/state-evaluation";

const NOW = "2026-09-05T12:00:00.000Z";
const MON = "mon_state";
const RACE = "mon_race";
const URL = "https://target.example.com/health";

// Minute slots (PRD §15.4 shape). Lexicographic order == chronological order.
const T = (minute: number, second = 0) => `2026-09-05T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

let testDb: TestD1;

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

function consumerFor(healthy: boolean, onTransition?: TransitionListener) {
  return createQueueConsumer({ checkerDeps: { fetchImpl: fetchReturning(healthy ? 200 : 500), onTransition } });
}

async function stateRow(monitorId: string): Promise<Record<string, unknown>> {
  const row = await testDb.d1
    .prepare("SELECT * FROM monitor_state WHERE monitor_id = ?")
    .bind(monitorId)
    .first<Record<string, unknown>>();
  expect(row).not.toBeNull();
  return row as Record<string, unknown>;
}

async function resetState(monitorId: string, patch: Record<string, unknown> = {}): Promise<void> {
  await testDb.d1
    .prepare(
      `UPDATE monitor_state SET status = 'unknown', consecutive_failures = 0, consecutive_successes = 0,
       failure_sequence_started_at = NULL, last_evaluated_scheduled_for = NULL, last_checked_at = NULL,
       last_success_at = NULL, last_failure_at = NULL, last_status_code = NULL, last_response_time_ms = NULL,
       last_reason_code = NULL, state_version = 0, updated_at = ? WHERE monitor_id = ?`,
    )
    .bind(NOW, monitorId)
    .run();
  const sets = Object.entries(patch);
  for (const [key, value] of sets) {
    await testDb.d1
      .prepare(`UPDATE monitor_state SET ${key} = ? WHERE monitor_id = ?`)
      .bind(value as string, monitorId)
      .run();
  }
}

beforeAll(async () => {
  testDb = await createTestDb();
  const db = (await import("../../worker/lib/db")).getDb(testDb.env);
  const { monitors, monitorState } = await import("../../db/schema");
  for (const id of [MON, RACE]) {
    await db.insert(monitors).values({
      id,
      clientId: "cli_morabeza",
      name: `State fixture ${id}`,
      url: URL,
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

describe("scheduled checks drive the state machine end-to-end", () => {
  it("unknown → up on the first healthy scheduled check, with diagnostics and version maintained", async () => {
    await resetState(MON);
    const transitions: StateTransitionEvent[] = [];
    const consumer = consumerFor(true, (e) => {
      transitions.push(e);
    });

    await consumer(batch([message(MON, T(1))]), testDb.env);

    const row = await stateRow(MON);
    expect(row.status).toBe("up");
    expect(row.state_version).toBe(1);
    expect(row.last_evaluated_scheduled_for).toBe(T(1));
    expect(row.consecutive_successes).toBe(1);
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_checked_at).not.toBeNull();
    expect(row.last_success_at).not.toBeNull();
    expect(row.last_failure_at).toBeNull();
    expect(row.last_status_code).toBe(200);
    expect(row.last_reason_code).toBe("ok");

    // §12.5: unknown→up emits a transition, but never a RECOVERED intent.
    expect(transitions.map((t) => t.transition.type)).toEqual(["up"]);
    expect(transitions.some((t) => t.transition.type === "recovered")).toBe(false);
  });

  it("third failure declares DOWN; continued failure re-applies diagnostics without a second transition", async () => {
    await resetState(MON);
    const transitions: StateTransitionEvent[] = [];
    const failing = consumerFor(false, (e) => { transitions.push(e); });

    // Slots are unique per test: the whole file shares one D1, and check ids
    // are deterministic per slot (PRD §15.4) — collisions would trip #9's
    // duplicate skip instead of the state machine.
    await failing(batch([message(MON, T(11)), message(MON, T(12)), message(MON, T(13)), message(MON, T(14))]), testDb.env);

    const row = await stateRow(MON);
    expect(row.status).toBe("down");
    expect(row.consecutive_failures).toBe(4);
    expect(row.state_version).toBe(4); // every applied result bumps the version
    expect(row.last_evaluated_scheduled_for).toBe(T(14));
    expect(row.last_failure_at).not.toBeNull();
    expect(row.last_reason_code).toBe("unexpected_status");

    // Exactly ONE down transition (threshold crossing); stamped with the FIRST
    // failure of the qualifying sequence (PRD §12.3).
    expect(transitions.map((t) => t.transition.type)).toEqual(["down"]);
    expect(transitions[0].transition.failureSequenceStartedAt).not.toBeNull();
    expect(transitions[0].checkId).toBe(`${MON}:${T(13)}`);
  });

  it("first success while DOWN does not recover; second success does (recovery threshold 2)", async () => {
    await resetState(MON, { status: "down", consecutive_failures: 3, state_version: 3, failure_sequence_started_at: T(1) });
    const transitions: StateTransitionEvent[] = [];
    const healthy = consumerFor(true, (e) => { transitions.push(e); });

    await healthy(batch([message(MON, T(21)), message(MON, T(22))]), testDb.env);

    const row = await stateRow(MON);
    expect(row.status).toBe("up");
    expect(row.state_version).toBe(5); // 3 + two applied successes
    expect(row.last_evaluated_scheduled_for).toBe(T(22));
    expect(row.consecutive_successes).toBe(2);
    expect(row.failure_sequence_started_at).toBeNull();
    expect(transitions.map((t) => t.transition.type)).toEqual(["recovered"]);
    expect(transitions[0].transition.fromStatus).toBe("down");
  });

  it("diagnostics-only applies (below-threshold failures while unknown) still maintain last_evaluated_scheduled_for + state_version", async () => {
    await resetState(MON);
    const failing = consumerFor(false);

    await failing(batch([message(MON, T(31)), message(MON, T(32))]), testDb.env);

    const row = await stateRow(MON);
    expect(row.status).toBe("unknown"); // no early DOWN (threshold 3)
    expect(row.state_version).toBe(2);
    expect(row.last_evaluated_scheduled_for).toBe(T(32));
    expect(row.consecutive_failures).toBe(2);
    expect(row.last_failure_at).not.toBeNull();
  });
});

describe("out-of-order protection + compare-and-set (PRD §16.5)", () => {
  it("a late older result persists as history but cannot roll state backwards", async () => {
    await resetState(MON);
    const consumer = consumerFor(true);
    await consumer(batch([message(MON, T(5))]), testDb.env); // state @ T5, up
    const before = await stateRow(MON);

    // A late delivery of an OLDER slot (fresh check id → claimable) that fails.
    const late = consumerFor(false);
    const lateMsg = message(MON, T(2));
    await late(batch([lateMsg]), testDb.env);

    expect(lateMsg.ack).toHaveBeenCalledTimes(1); // job completes — history only
    const resultRow = await testDb.d1
      .prepare("SELECT * FROM check_results WHERE id = ?")
      .bind(`${MON}:${T(2)}`)
      .first<Record<string, unknown>>();
    expect(resultRow).not.toBeNull(); // persisted for history
    expect(resultRow?.is_healthy).toBe(0);

    const after = await stateRow(MON);
    expect(after).toEqual(before); // state byte-identical — no backwards roll
  });

  it("equal-slot results are treated as already-evaluated (no re-evaluation of the same slot)", async () => {
    await resetState(MON);
    const consumer = consumerFor(true);
    await consumer(batch([message(MON, T(6))]), testDb.env);
    const before = await stateRow(MON);

    const sameSlot = consumerFor(false);
    const msg = message(MON, T(6), { checkId: `${MON}:${T(6)}:late-variant` });
    await sameSlot(batch([msg]), testDb.env);

    const after = await stateRow(MON);
    expect(after).toEqual(before);
  });

  it("CAS primitive: stale expected version loses, correct version applies exactly once", async () => {
    const { casUpdateMonitorState, ensureMonitorStateRow } = await import("../../worker/repositories/monitor-state");
    const db = (await import("../../worker/lib/db")).getDb(testDb.env);
    await resetState(RACE);
    const state = await ensureMonitorStateRow(db, RACE, NOW);

    const staleOk = await casUpdateMonitorState(db, RACE, state.stateVersion, { status: "down" });
    expect(staleOk).toBe(true);

    // The SAME expected version again must lose — no blind overwrite.
    const retry = await casUpdateMonitorState(db, RACE, state.stateVersion, { status: "up" });
    expect(retry).toBe(false);
    const after = await stateRow(RACE);
    expect(after.status).toBe("down");
    expect(after.state_version).toBe(state.stateVersion + 1);
  });

  it("interleaved deliveries converge on the NEWEST slot without corruption", async () => {
    await resetState(RACE);
    // Two independent "workers" process an older and a newer slot concurrently.
    const older = consumerFor(false);
    const newer = consumerFor(true);
    await Promise.all([
      older(batch([message(RACE, T(20))]), testDb.env),
      newer(batch([message(RACE, T(21))]), testDb.env),
    ]);

    const row = await stateRow(RACE);
    // Newest slot owns the state — whatever the interleave, T21 wins.
    expect(row.last_evaluated_scheduled_for).toBe(T(21));
    expect(row.status).toBe("up");
    expect(row.consecutive_failures).toBe(0);
    expect(Number(row.state_version)).toBeGreaterThanOrEqual(1);

    // The loser of the race (older slot, if it applied first) must not be able
    // to regress: re-delivering the older slot changes nothing.
    const before = await stateRow(RACE);
    await consumerFor(false)(batch([message(RACE, T(20, 30))]), testDb.env);
    expect(await stateRow(RACE)).toEqual(before);
  });

  it("service-level race: newest slot wins even when the older evaluation applies first", async () => {
    const db = (await import("../../worker/lib/db")).getDb(testDb.env);
    await resetState(RACE);
    const mk = (slot: string, healthy: boolean) =>
      evaluateCheckAgainstState(
        { db },
        { monitorId: RACE, failureThreshold: 3, recoveryThreshold: 2 },
        {
          checkId: `${RACE}:${slot}`,
          source: "scheduled",
          scheduledFor: slot,
          isHealthy: healthy,
          maintenanceExcluded: false,
          affectsState: true,
          statusCode: healthy ? 200 : 500,
          responseTimeMs: 10,
          reasonCode: healthy ? "ok" : "unexpected_status",
          completedAt: slot,
        },
      );

    await Promise.all([mk(T(30), false), mk(T(31), true)]);

    const row = await stateRow(RACE);
    expect(row.last_evaluated_scheduled_for).toBe(T(31));
    expect(row.status).toBe("up");
  });
});

describe("gates: paused / manual / maintenance never transition", () => {
  it("paused monitor: scheduled result persists but state is untouched", async () => {
    await resetState(MON, { status: "paused", state_version: 7, last_evaluated_scheduled_for: T(1) });
    const failing = consumerFor(false);

    const msg = message(MON, T(40));
    await failing(batch([msg]), testDb.env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    const row = await stateRow(MON);
    expect(row.status).toBe("paused");
    expect(row.state_version).toBe(7); // CAS never applied
    expect(row.last_evaluated_scheduled_for).toBe(T(1));
    expect(row.consecutive_failures).toBe(0);
  });

  it("manual result (affects_state=0) persists with flags but never touches state", async () => {
    await resetState(MON, { status: "down", state_version: 4, consecutive_failures: 3, failure_sequence_started_at: T(1) });
    const failing = consumerFor(false);

    const manual = message(MON, "manual-slot", {
      checkId: `${MON}:manual-1`,
      scheduledFor: null,
      source: "manual",
      affectsState: false,
    });
    await failing(batch([manual]), testDb.env);

    expect(manual.ack).toHaveBeenCalledTimes(1);
    const resultRow = await testDb.d1
      .prepare("SELECT source, affects_state, is_healthy FROM check_results WHERE id = ?")
      .bind(`${MON}:manual-1`)
      .first<Record<string, unknown>>();
    expect(resultRow).toMatchObject({ source: "manual", affects_state: 0, is_healthy: 0 });

    const row = await stateRow(MON);
    expect(row.status).toBe("down");
    expect(row.state_version).toBe(4); // untouched
    expect(row.last_evaluated_scheduled_for).toBeNull(); // resetState cleared it; never set by manual
  });

  it("maintenance-excluded results are skipped by the evaluator (flag honored; live flagging lands in #15)", async () => {
    const db = (await import("../../worker/lib/db")).getDb(testDb.env);
    await resetState(MON, { status: "up", state_version: 2, last_evaluated_scheduled_for: T(9) });

    const outcome = await evaluateCheckAgainstState(
      { db },
      { monitorId: MON, failureThreshold: 3, recoveryThreshold: 2 },
      {
        checkId: `${MON}:maintenance-1`,
        source: "scheduled",
        scheduledFor: T(50),
        isHealthy: false,
        maintenanceExcluded: true,
        affectsState: true,
        statusCode: 500,
        responseTimeMs: 5,
        reasonCode: "unexpected_status",
        completedAt: T(50),
      },
    );
    expect(outcome).toEqual({ applied: false, reason: "maintenance_excluded" });

    const row = await stateRow(MON);
    expect(row.status).toBe("up");
    expect(row.state_version).toBe(2);
    expect(row.last_evaluated_scheduled_for).toBe(T(9));
  });

  it("transition listener seam receives full context for #13/#17 to subscribe", async () => {
    await resetState(MON);
    const events: StateTransitionEvent[] = [];
    const listener: TransitionListener = (e) => {
      events.push(e);
    };
    const failing = consumerFor(false, listener);

    await failing(batch([message(MON, T(55)), message(MON, T(56)), message(MON, T(57))]), testDb.env);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      monitorId: MON,
      checkId: `${MON}:${T(57)}`,
      triggerScheduledFor: T(57),
    });
    expect(events[0].transition).toMatchObject({
      type: "down",
      fromStatus: "unknown",
      toStatus: "down",
    });
    expect(events[0].transition.failureSequenceStartedAt).not.toBeNull();
    expect(events[0].stateVersion).toBe(3);
  });

  it("a monitor whose state row is missing gets one lazily created at first evaluation (§12.2 initial state)", async () => {
    await testDb.d1.prepare("DELETE FROM monitor_state WHERE monitor_id = ?").bind(MON).run();

    const healthy = consumerFor(true);
    await healthy(batch([message(MON, T(70))]), testDb.env);

    const row = await stateRow(MON); // throws if no row was created
    expect(row.status).toBe("up");
    expect(row.state_version).toBe(1);
    expect(row.last_evaluated_scheduled_for).toBe(T(70));
    expect(row.consecutive_failures).toBe(0);
  });
});
