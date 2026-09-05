/**
 * Issue #10 — cron scheduler (PRD §15, §36, §37.7–37.8): minute-slot ticks
 * over real D1 with a recording queue fake. Covers cadence for every
 * interval, deterministic ids, enqueue-failure retry, overdue behavior,
 * run summaries, housekeeping slots, and the zero-fetch guarantee.
 *
 * NOTE: the whole file shares one D1, and monitors that miss their schedule
 * stay due forever (§15.3) — so per-monitor assertions are filtered by job id
 * rather than asserting global counts wherever leftover fixtures could leak.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { disposeTestDb, createTestDb, type TestD1 } from "../helpers/d1";
import { housekeepingJobsForSlot, minuteSlot, nextCheckAtFor, queueBindingToQueueLike, runSchedulerTick } from "../../worker/scheduler/scheduler";
import type { QueueLike } from "../../worker/queue/producer";

const T0 = "2026-09-05T12:00:00.000Z";

let testDb: TestD1;

interface RecordedSend {
  kind: "send" | "batch";
  bodies: unknown[];
}

function recordingQueue(failBatch = false, failSend = false): { queue: QueueLike; sent: RecordedSend[] } {
  const sent: RecordedSend[] = [];
  return {
    sent,
    queue: {
      send: async (body: unknown) => {
        if (failSend) throw new Error("queue send unavailable");
        sent.push({ kind: "send", bodies: [body] });
      },
      sendBatch: async (bodies: unknown[]) => {
        if (failBatch) throw new Error("queue batch unavailable");
        sent.push({ kind: "batch", bodies });
      },
    },
  };
}

/** All enqueued monitor.check job ids across recorded sends. */
function enqueuedCheckJobs(sent: RecordedSend[]): string[] {
  return sent
    .flatMap((s) => s.bodies)
    .map((body) => {
      const envelope = body as { type: string; jobId: string };
      return envelope.type === "monitor.check" ? envelope.jobId : "";
    })
    .filter((id) => id !== "");
}

function jobsFor(sent: RecordedSend[], monitorId: string): string[] {
  return enqueuedCheckJobs(sent).filter((jobId) => jobId.startsWith(`${monitorId}:`));
}

async function insertMonitor(id: string, intervalSeconds: number, nextCheckAt: string, flags: { enabled?: number; archived?: boolean } = {}): Promise<void> {
  const db = (await import("../../worker/lib/db")).getDb(testDb.env);
  const { monitors } = await import("../../db/schema");
  await db.insert(monitors).values({
    id,
    clientId: "cli_morabeza",
    name: `Sched ${id}`,
    url: "https://target.example.com/health",
    intervalSeconds,
    enabled: flags.enabled ?? 1,
    nextCheckAt,
    archivedAt: flags.archived ? T0 : null,
    createdAt: T0,
    updatedAt: T0,
  });
}

beforeAll(async () => {
  testDb = await createTestDb();
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("minute tick drives every interval from one cron (PRD §15)", () => {
  it("checks 60/120/300/600s monitors on their own cadence with simulated minute ticks", async () => {
    for (const [id, interval] of [["mon_i60", 60], ["mon_i120", 120], ["mon_i300", 300], ["mon_i600", 600]] as const) {
      await insertMonitor(id, interval, T0);
    }

    const seen = new Map<string, number[]>();
    for (let minute = 0; minute <= 10; minute++) {
      const slot = minuteSlot(new Date(Date.parse(T0) + minute * 60_000));
      const { queue, sent } = recordingQueue();
      await runSchedulerTick({ env: testDb.env, queue, now: new Date(slot) });

      for (const jobId of enqueuedCheckJobs(sent)) {
        // jobId = "<monitorId>:<slot>" — the monitor id never contains colons.
        const monitorId = jobId.split(":")[0];
        if (monitorId.startsWith("mon_i")) {
          seen.set(monitorId, [...(seen.get(monitorId) ?? []), minute]);
        }
      }
    }

    expect(seen.get("mon_i60")).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(seen.get("mon_i120")).toEqual([0, 2, 4, 6, 8, 10]);
    expect(seen.get("mon_i300")).toEqual([0, 5, 10]);
    expect(seen.get("mon_i600")).toEqual([0, 10]);
  });

  it("skips disabled and archived monitors", async () => {
    await insertMonitor("mon_off", 60, T0, { enabled: 0 });
    await insertMonitor("mon_arch", 60, T0, { archived: true });

    const { queue, sent } = recordingQueue();
    await runSchedulerTick({ env: testDb.env, queue, now: new Date(T0) });

    expect(jobsFor(sent, "mon_off")).toEqual([]);
    expect(jobsFor(sent, "mon_arch")).toEqual([]);
  });
});

describe("deterministic ids + missed schedules (PRD §15.3, §15.4)", () => {
  it("two scheduler runs for the same slot enqueue the SAME job id", async () => {
    await insertMonitor("mon_det", 300, T0);
    const first = recordingQueue();
    await runSchedulerTick({ env: testDb.env, queue: first.queue, now: new Date(T0) });

    // Simulate the same cron slot firing again (at-least-once): the monitor is
    // due once more before any consumer executed the first job.
    await testDb.d1.prepare("UPDATE monitors SET next_check_at = ? WHERE id = 'mon_det'").bind(T0).run();

    const second = recordingQueue();
    await runSchedulerTick({ env: testDb.env, queue: second.queue, now: new Date(T0) });

    expect(jobsFor(first.sent, "mon_det")).toEqual([`mon_det:${T0}`]);
    expect(jobsFor(second.sent, "mon_det")).toEqual(jobsFor(first.sent, "mon_det"));
  });

  it("an overdue monitor gets exactly ONE current check and a future next_check_at — no backfill", async () => {
    // Missed its whole 300s schedule for the last hour (11:00 → 12:00).
    await insertMonitor("mon_overdue", 300, "2026-09-05T11:00:00.000Z");

    const { queue, sent } = recordingQueue();
    await runSchedulerTick({ env: testDb.env, queue, now: new Date(T0) });

    const overdueJobs = jobsFor(sent, "mon_overdue");
    expect(overdueJobs).toEqual([`mon_overdue:${T0}`]); // current slot only — no 11:xx backfill

    const row = await testDb.d1.prepare("SELECT next_check_at FROM monitors WHERE id = 'mon_overdue'").first<{ next_check_at: string }>();
    expect(row?.next_check_at).toBe(nextCheckAtFor(300, T0)); // strictly future per interval
  });
});

describe("enqueue failure semantics (PRD §37.7)", () => {
  it("a failed batch leaves its monitors due (next_check_at unchanged) and they retry next pass", async () => {
    await insertMonitor("mon_retry", 120, T0);

    const failing = recordingQueue(true);
    const failedResult = await runSchedulerTick({ env: testDb.env, queue: failing.queue, now: new Date(T0) });
    expect(failedResult.failedBatchCount).toBe(1);
    expect(jobsFor(failing.sent, "mon_retry")).toEqual([]);

    const row = await testDb.d1.prepare("SELECT next_check_at FROM monitors WHERE id = 'mon_retry'").first<{ next_check_at: string }>();
    expect(row?.next_check_at).toBe(T0); // still due

    // Next pass (one minute later) succeeds and advances the monitor.
    const nextSlot = minuteSlot(new Date(Date.parse(T0) + 60_000));
    const working = recordingQueue();
    const okResult = await runSchedulerTick({ env: testDb.env, queue: working.queue, now: new Date(nextSlot) });
    expect(okResult.failedBatchCount).toBe(0);
    expect(jobsFor(working.sent, "mon_retry")).toEqual([`mon_retry:${nextSlot}`]);
    const advanced = await testDb.d1.prepare("SELECT next_check_at FROM monitors WHERE id = 'mon_retry'").first<{ next_check_at: string }>();
    expect(advanced?.next_check_at).toBe(nextCheckAtFor(120, nextSlot));
  });
});

describe("pagination (PRD §36)", () => {
  it("drains more due monitors than one page holds, enqueuing each exactly once", async () => {
    const count = 7;
    for (let i = 0; i < count; i++) {
      await insertMonitor(`mon_page_${i}`, 60, T0);
    }

    const { queue, sent } = recordingQueue();
    await runSchedulerTick({ env: testDb.env, queue, now: new Date(T0), pageSize: 3 });

    const pageJobs = enqueuedCheckJobs(sent).filter((jobId) => jobId.startsWith("mon_page_"));
    expect(pageJobs).toHaveLength(count);
    expect(new Set(pageJobs).size).toBe(count); // no page overlap → no duplicates
  });
});

describe("run summary + heartbeat (PRD §15.2, §17.12, §17.13)", () => {
  it("writes scheduler_runs and last_scheduler_at on every run", async () => {
    await insertMonitor("mon_summary", 60, T0);

    const sysBefore = Date.now();
    const slot = minuteSlot(new Date(Date.parse(T0) + 120_000));
    const { queue, sent } = recordingQueue();
    const result = await runSchedulerTick({ env: testDb.env, queue, now: new Date(slot) });

    expect(jobsFor(sent, "mon_summary")).toEqual([`mon_summary:${slot}`]);
    const run = await testDb.d1
      .prepare("SELECT * FROM scheduler_runs WHERE id = ?")
      .bind(result.runId)
      .first<Record<string, unknown>>();
    expect(run).not.toBeNull();
    expect(run?.scheduled_at).toBe(slot);
    expect(run?.due_monitor_count).toBe(result.dueMonitorCount);
    expect(run?.enqueued_count).toBe(result.enqueuedCount);
    expect(run?.failed_batch_count).toBe(0);
    expect(Number(run?.due_monitor_count)).toBeGreaterThanOrEqual(1);

    const sys = await testDb.d1
      .prepare("SELECT last_scheduler_at FROM system_state WHERE id = 'system'")
      .first<{ last_scheduler_at: string }>();
    // The heartbeat is real wall-clock (when the tick ran), not the synthetic slot.
    expect(sys?.last_scheduler_at).not.toBeNull();
    expect(Date.parse(sys!.last_scheduler_at)).toBeGreaterThanOrEqual(sysBefore);
  });
});

describe("housekeeping dispatch (PRD §15.2 step 8, §37.8)", () => {
  it("emits envelopes at the right slots with deterministic job ids", () => {
    // :00 → heartbeat only
    expect(housekeepingJobsForSlot("2026-09-05T12:00:00.000Z").map((j) => j.type)).toEqual(["system.heartbeat"]);
    // :05 → hourly rollup for the just-completed hour (+ heartbeat):
    // at 13:05 the hour that just closed is 12:00–13:00 → hourStart 12:00.
    const at5 = housekeepingJobsForSlot("2026-09-05T13:05:00.000Z");
    expect(at5.map((j) => j.type)).toEqual(["system.heartbeat", "rollup.hourly"]);
    const hourly = at5.find((j) => j.type === "rollup.hourly")!;
    expect(hourly.jobId).toBe("rollup.hourly:2026-09-05T12:00:00.000Z");
    expect(hourly.payload).toEqual({ hourStart: "2026-09-05T12:00:00.000Z" });
    // 00:06 → daily rollup for the PREVIOUS UTC day
    const atDaily = housekeepingJobsForSlot("2026-09-06T00:06:00.000Z");
    expect(atDaily.map((j) => j.type)).toEqual(["rollup.daily"]);
    expect(atDaily[0].jobId).toBe("rollup.daily:2026-09-05T00:00:00.000Z");
    expect(atDaily[0].payload).toEqual({ dayStart: "2026-09-05T00:00:00.000Z" });
    // 00:07 → retention cleanup for the run day
    const atCleanup = housekeepingJobsForSlot("2026-09-06T00:07:00.000Z");
    expect(atCleanup.map((j) => j.type)).toEqual(["retention.cleanup"]);
    expect(atCleanup[0].jobId).toBe("retention.cleanup:2026-09-06T00:00:00.000Z");
    // an ordinary off-slot minute → nothing
    expect(housekeepingJobsForSlot("2026-09-05T12:07:00.000Z")).toEqual([]);
  });

  it("a housekeeping dispatch failure does not skip or undo monitor scheduling (§37.8)", async () => {
    await insertMonitor("mon_hk", 60, T0);
    const sent: RecordedSend[] = [];
    const queue: QueueLike = {
      send: async () => {
        throw new Error("housekeeping unavailable");
      },
      sendBatch: async (bodies) => {
        sent.push({ kind: "batch", bodies });
      },
    };

    // :05 slot → heartbeat + hourly rollup both fail on send; monitor checks flow via sendBatch.
    const slot = "2026-09-05T14:05:00.000Z";
    const result = await runSchedulerTick({ env: testDb.env, queue, now: new Date(slot) });

    expect(jobsFor(sent, "mon_hk")).toEqual([`mon_hk:${slot}`]);
    expect(result.housekeepingFailures.map((f) => f.type).sort()).toEqual(["rollup.hourly", "system.heartbeat"]);
    const row = await testDb.d1.prepare("SELECT next_check_at FROM monitors WHERE id = 'mon_hk'").first<{ next_check_at: string }>();
    expect(row?.next_check_at).toBe(nextCheckAtFor(60, slot)); // advancement untouched by housekeeping failures
  });
});

describe("scheduler performs zero outbound HTTP fetches (PRD §15.2)", () => {
  it("never calls fetch, even with due monitors", async () => {
    await insertMonitor("mon_nofetch", 60, T0);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { queue } = recordingQueue();
    await runSchedulerTick({ env: testDb.env, queue, now: new Date(T0) });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("production adapter", () => {
  it("queueBindingToQueueLike wraps binding messages as { body } and flattens sends", async () => {
    const sent: unknown[] = [];
    const sentBatch: unknown[][] = [];
    const binding = {
      send: async (body: unknown) => {
        sent.push(body);
        return {} as QueueSendResponse;
      },
      sendBatch: async (messages: Array<{ body: unknown }>) => {
        sentBatch.push(messages.map((m) => m.body));
        return {} as QueueSendBatchResponse;
      },
    };

    const like = queueBindingToQueueLike(binding as unknown as Queue);
    await like.send({ v: 1 });
    await like.sendBatch([{ v: 2 }, { v: 3 }]);

    expect(sent).toEqual([{ v: 1 }]);
    expect(sentBatch).toEqual([[{ v: 2 }, { v: 3 }]]);
  });

  it("a tick at a housekeeping slot dispatches the envelopes end-to-end", async () => {
    const { queue, sent } = recordingQueue();
    const result = await runSchedulerTick({ env: testDb.env, queue, now: new Date("2026-09-05T15:05:00.000Z") });

    expect(result.housekeepingFailures).toEqual([]);
    expect(result.housekeeping.map((h) => h.type).sort()).toEqual(["rollup.hourly", "system.heartbeat"]);
    const sentTypes = sent.flatMap((s) => s.bodies).map((b) => (b as { type: string }).type);
    expect(sentTypes).toContain("rollup.hourly");
    expect(sentTypes).toContain("system.heartbeat");
  });
});
