/**
 * Issue #15 — maintenance exclusion semantics in the check pipeline (PRD
 * §14.1–§14.3): scope matrix (global/client/monitor × healthy/failing),
 * overlaps, end-of-window resumption without phantom recovery, and
 * cancellation. Real D1 via miniflare; fetch mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { disposeTestDb, createTestDb, type TestD1 } from "../helpers/d1";
import { QUEUE_NAMES } from "../../worker/queue/schemas";
import { createQueueConsumer, type BatchLike, type MessageLike } from "../../worker/queue/consumer";
import type { StateTransitionEvent } from "../../worker/services/state-evaluation";

const NOW = "2026-09-05T12:00:00.000Z";
const SLOT = "2026-09-05T12:00:00.000Z";
const URL = "https://target.example.com/health";

let testDb: TestD1;
let events: StateTransitionEvent[];

function message(monitorId: string, checkId: string): MessageLike {
  return {
    id: `msg_${checkId}`,
    body: {
      v: 1,
      type: "monitor.check",
      jobId: checkId,
      payload: {
        monitorId,
        checkId,
        scheduledFor: SLOT,
        source: "scheduled",
        affectsState: true,
      },
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function insertWindow(window: {
  id: string;
  scopeType: "global" | "client" | "monitor";
  scopeId: string | null;
  /** Offsets in ms from REAL now (negative = past). */
  startsAtMs: number;
  endsAtMs: number;
  cancelledAt?: string;
}): Promise<void> {
  const db = (await import("../../worker/lib/db")).getDb(testDb.env);
  const { maintenanceWindows } = await import("../../db/schema");
  await db.insert(maintenanceWindows).values({
    id: window.id,
    title: `Window ${window.id}`,
    scopeType: window.scopeType,
    scopeId: window.scopeId,
    startsAt: new Date(Date.now() + window.startsAtMs).toISOString(),
    endsAt: new Date(Date.now() + window.endsAtMs).toISOString(),
    cancelledAt: window.cancelledAt ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function runCheck(checkId: string, monitorId: string, healthy: boolean): Promise<MessageLike> {
  const msg = message(monitorId, checkId);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const res = new Response(healthy ? "fine" : "boom", { status: healthy ? 200 : 500 });
    Object.defineProperty(res, "url", { value: String(input), configurable: true });
    return res;
  }) as unknown as typeof fetch;
  const consumer = createQueueConsumer({
    checkerDeps: {
      fetchImpl: fetchMock,
      onTransition: (e) => {
        events.push(e);
      },
    },
  });
  await consumer({ queue: QUEUE_NAMES.checks, messages: [msg] } as BatchLike, testDb.env);
  expect(msg.ack).toHaveBeenCalledTimes(1);
  return msg;
}

async function resultRow(checkId: string): Promise<Record<string, unknown>> {
  const row = await testDb.d1.prepare("SELECT * FROM check_results WHERE id = ?").bind(checkId).first<Record<string, unknown>>();
  expect(row).not.toBeNull();
  return row as Record<string, unknown>;
}

async function stateRow(monitorId: string): Promise<Record<string, unknown>> {
  const row = await testDb.d1
    .prepare("SELECT * FROM monitor_state WHERE monitor_id = ?")
    .bind(monitorId)
    .first<Record<string, unknown>>();
  expect(row).not.toBeNull();
  return row as Record<string, unknown>;
}

/** Window fixtures from earlier tests may still be live — non-exclusion tests start clean. */
async function clearWindows(): Promise<void> {
  await testDb.d1.prepare("DELETE FROM maintenance_windows").run();
}

beforeAll(async () => {
  testDb = await createTestDb();
  const db = (await import("../../worker/lib/db")).getDb(testDb.env);
  const { clients, monitors, monitorState } = await import("../../db/schema");
  await db.insert(clients).values({
    id: "cli_other",
    name: "Other Client",
    slug: "other",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(monitors).values([
    { id: "mon_a", clientId: "cli_morabeza", name: "A", url: URL, nextCheckAt: NOW, createdAt: NOW, updatedAt: NOW },
    { id: "mon_b", clientId: "cli_other", name: "B", url: URL, nextCheckAt: NOW, createdAt: NOW, updatedAt: NOW },
    { id: "mon_up", clientId: "cli_morabeza", name: "Up Fixture", url: URL, nextCheckAt: NOW, createdAt: NOW, updatedAt: NOW },
  ]);
  for (const id of ["mon_a", "mon_b", "mon_up"]) {
    await db.insert(monitorState).values({ monitorId: id, status: "unknown", stateVersion: 0, updatedAt: NOW });
  }
  events = [];
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("scope matrix: any active window ⇒ excluded (PRD §14.2)", () => {
  it("monitor scope: only that monitor is excluded", async () => {
    await insertWindow({ id: "win_mon_a", scopeType: "monitor", scopeId: "mon_a", startsAtMs: -60_000, endsAtMs: 60_000 });

    await runCheck("chk_mon_a_win", "mon_a", false); // failing target during its window
    await runCheck("chk_mon_b_nowin", "mon_b", false); // failing target, no window

    expect(await resultRow("chk_mon_a_win")).toMatchObject({ maintenance_excluded: 1, is_healthy: 0 });
    expect(await resultRow("chk_mon_b_nowin")).toMatchObject({ maintenance_excluded: 0 });

    // Excluded → state untouched; not excluded → normal evaluation (unknown, 1 failure < threshold 3).
    expect(await stateRow("mon_a")).toMatchObject({ status: "unknown", state_version: 0, consecutive_failures: 0 });
    expect(await stateRow("mon_b")).toMatchObject({ status: "unknown", state_version: 1, consecutive_failures: 1 });
  });

  it("client scope: excludes every monitor of that client only", async () => {
    await clearWindows();
    await insertWindow({ id: "win_cli_other", scopeType: "client", scopeId: "cli_other", startsAtMs: -60_000, endsAtMs: 60_000 });

    await runCheck("chk_mon_b_cli", "mon_b", false);
    await runCheck("chk_mon_a_cli", "mon_a", false);

    expect(await resultRow("chk_mon_b_cli")).toMatchObject({ maintenance_excluded: 1 });
    expect(await resultRow("chk_mon_a_cli")).toMatchObject({ maintenance_excluded: 0 });
  });

  it("global scope: excludes all monitors", async () => {
    await insertWindow({ id: "win_global", scopeType: "global", scopeId: null, startsAtMs: -60_000, endsAtMs: 60_000 });

    await runCheck("chk_mon_a_g", "mon_a", false);
    await runCheck("chk_mon_b_g", "mon_b", false);

    expect(await resultRow("chk_mon_a_g")).toMatchObject({ maintenance_excluded: 1 });
    expect(await resultRow("chk_mon_b_g")).toMatchObject({ maintenance_excluded: 1 });
  });

  it("overlapping windows behave sanely — one flag, still excluded", async () => {
    await insertWindow({ id: "win_g2", scopeType: "global", scopeId: null, startsAtMs: -60_000, endsAtMs: 60_000 });
    await insertWindow({ id: "win_m2", scopeType: "monitor", scopeId: "mon_a", startsAtMs: -30_000, endsAtMs: 120_000 });

    const before = await stateRow("mon_a");
    await runCheck("chk_mon_a_overlap", "mon_a", false);
    expect(await resultRow("chk_mon_a_overlap")).toMatchObject({ maintenance_excluded: 1 });
    expect(await stateRow("mon_a")).toEqual(before); // excluded → no evaluation at all
  });

  it("healthy targets are flagged too (exclusion is health-independent), and manual checks resolve windows", async () => {
    await clearWindows();
    await insertWindow({ id: "win_healthy", scopeType: "monitor", scopeId: "mon_a", startsAtMs: -60_000, endsAtMs: 60_000 });

    // Scheduled + healthy inside the window: flagged, state untouched.
    const before = await stateRow("mon_a");
    await runCheck("chk_mon_a_healthy_win", "mon_a", true);
    expect(await resultRow("chk_mon_a_healthy_win")).toMatchObject({ maintenance_excluded: 1, is_healthy: 1 });
    expect(await stateRow("mon_a")).toEqual(before);

    // Manual + failing inside the window: flagged (truthful recording) and
    // already state-inert via affects_state=0.
    const manual: MessageLike = {
      id: "msg_manual_win",
      body: {
        v: 1,
        type: "monitor.check",
        jobId: "chk_manual_win",
        payload: {
          monitorId: "mon_a",
          checkId: "chk_manual_win",
          scheduledFor: null,
          source: "manual",
          affectsState: false,
        },
      },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const consumer = createQueueConsumer({
      checkerDeps: {
        fetchImpl: fetchMock,
        onTransition: (e) => {
          events.push(e);
        },
      },
    });
    await consumer({ queue: QUEUE_NAMES.checks, messages: [manual] } as BatchLike, testDb.env);
    expect(await resultRow("chk_manual_win")).toMatchObject({
      maintenance_excluded: 1,
      source: "manual",
      affects_state: 0,
    });
    expect(await stateRow("mon_a")).toEqual(before); // manual never evaluates
  });

  it("windows outside the check time never match (ended / not started / cancelled)", async () => {
    await clearWindows();
    await insertWindow({ id: "win_ended", scopeType: "monitor", scopeId: "mon_a", startsAtMs: -120_000, endsAtMs: -60_000 });
    await insertWindow({ id: "win_future", scopeType: "monitor", scopeId: "mon_a", startsAtMs: 60_000, endsAtMs: 120_000 });
    await insertWindow({
      id: "win_cancelled",
      scopeType: "monitor",
      scopeId: "mon_a",
      startsAtMs: -60_000,
      endsAtMs: 60_000,
      cancelledAt: NOW,
    });

    await runCheck("chk_mon_a_outside", "mon_a", false);
    expect(await resultRow("chk_mon_a_outside")).toMatchObject({ maintenance_excluded: 0 });
  });
});

describe("end of window resumes standard evaluation (PRD §14.3)", () => {
  it("no synthetic recovery; failing checks count again after the window; no phantom RECOVERED", async () => {
    await clearWindows();
    // Up monitor, window live NOW ending in +1s.
    const db = (await import("../../worker/lib/db")).getDb(testDb.env);
    const { monitorState } = await import("../../db/schema");
    await db
      .update(monitorState)
      .set({ status: "up", consecutiveSuccesses: 4, stateVersion: 4, updatedAt: NOW })
      .where(eq(monitorState.monitorId, "mon_up"));

    await insertWindow({ id: "win_up", scopeType: "monitor", scopeId: "mon_up", startsAtMs: -60_000, endsAtMs: 1_000 });

    // During the window: hard-failing target, state must not move.
    await runCheck("chk_up_during", "mon_up", false);
    expect(await resultRow("chk_up_during")).toMatchObject({ maintenance_excluded: 1 });
    expect(await stateRow("mon_up")).toMatchObject({ status: "up", state_version: 4, consecutive_failures: 0 });

    // After the window: a failing check evaluates NORMALLY again.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    events = [];
    await runCheck("chk_up_after", "mon_up", false);
    expect(await resultRow("chk_up_after")).toMatchObject({ maintenance_excluded: 0 });
    const after = await stateRow("mon_up");
    expect(after.status).toBe("up"); // 1 failure < threshold 3 → still up, but now COUNTED
    expect(after.consecutive_failures).toBe(1);
    expect(Number(after.state_version)).toBe(5);

    // No transition of any kind fired — in particular no phantom RECOVERED.
    expect(events).toHaveLength(0);
  });
});
