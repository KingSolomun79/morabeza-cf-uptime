/**
 * Cron scheduler (issue #10; PRD §15, §36, §37.7–§37.8).
 *
 * One Cron Trigger (`* * * * *`) drives ALL intervals. Each tick is
 * lightweight (PRD §15.2): normalize the minute slot → heartbeat → select due
 * monitors (enabled + next_check_at index) → enqueue deterministic
 * monitor.check messages in batches → advance next_check_at ONLY for work
 * successfully queued → record a scheduler_runs summary → dispatch
 * housekeeping envelopes (handlers land in #17/#18/#19).
 *
 * Guarantees:
 * - deterministic job ids per (monitor, slot) — PRD §15.4; duplicate enqueue
 *   or delivery is neutralized downstream by consumer-side idempotency (#9);
 * - missed schedules never backfill (§15.3): an overdue monitor gets exactly
 *   one current-slot check and a strictly-future next_check_at;
 * - an enqueue failure leaves that batch's monitors due (§37.7) — the next
 *   pass retries them;
 * - housekeeping failures never block monitor scheduling (§37.8);
 * - ZERO outbound HTTP fetches here — targets are only ever contacted by the
 *   queue consumer (§15.2, asserted in tests).
 */
import { and, asc, eq, gt, isNull, lte, or, type SQL } from "drizzle-orm";
import { monitors, schedulerRuns } from "../../db/schema";
import { getDb } from "../lib/db";
import { newId } from "../lib/ids";
import { logEvent } from "../lib/logging";
import { QueueProducer, type EnvelopeInput, type QueueLike } from "../queue/producer";
import type { MessageType } from "../queue/schemas";
import { touchSchedulerHeartbeat } from "../repositories/system";
import type { Env } from "../env";

/** One Queues sendBatch per page — Cloudflare caps batches at 100 messages. */
export const DUE_PAGE_SIZE = 100;

export interface SchedulerDeps {
  env: Env;
  /** Producer target; tests inject a recording fake. */
  queue: QueueLike;
  /** Overrides the tick time (tests drive synthetic UTC minutes). */
  now?: Date;
  pageSize?: number;
}

export interface HousekeepingDispatch {
  type: MessageType;
  jobId: string;
}

export interface SchedulerTickResult {
  slot: string;
  /** Id of the scheduler_runs summary row written by this tick. */
  runId: string;
  dueMonitorCount: number;
  enqueuedCount: number;
  failedBatchCount: number;
  durationMs: number;
  housekeeping: HousekeepingDispatch[];
  housekeepingFailures: HousekeepingDispatch[];
}

/** Truncates to the minute slot, ms-precision UTC ISO (PRD §15.1, §15.4). */
export function minuteSlot(date: Date): string {
  const truncated = new Date(date.getTime());
  truncated.setUTCSeconds(0, 0);
  return truncated.toISOString();
}

/**
 * Next due time per §15.3: strictly in the future relative to the slot, at
 * the monitor's cadence — an overdue monitor is checked once NOW, then
 * resumes its interval (no historical backfill).
 */
export function nextCheckAtFor(intervalSeconds: number, slot: string): string {
  return new Date(Date.parse(slot) + intervalSeconds * 1000).toISOString();
}

/** Adapts the production Queue binding to the producer's QueueLike port. */
export function queueBindingToQueueLike(binding: Queue): QueueLike {
  return {
    send: async (body) => {
      await binding.send(body);
    },
    sendBatch: async (bodies) => {
      await binding.sendBatch(bodies.map((body) => ({ body })));
    },
  };
}

/**
 * Housekeeping envelopes for a slot (PRD §15.2 step 8, §18). Envelopes only —
 * handler bodies arrive in #17 (nothing here), #18 (rollups), #19 (cleanup).
 * Slots are chosen to stagger D1 load: hourly rollup at :05 (previous hour),
 * daily rollup at 00:06 (previous UTC day, after the 23:xx hour rollup),
 * retention cleanup at 00:07, queue heartbeat every 5th minute.
 */
export function housekeepingJobsForSlot(slot: string): EnvelopeInput<MessageType>[] {
  const t = Date.parse(slot);
  const at = new Date(t);
  const minute = at.getUTCMinutes();
  const hour = at.getUTCHours();
  const jobs: EnvelopeInput<MessageType>[] = [];

  if (minute % 5 === 0) {
    jobs.push({ type: "system.heartbeat", jobId: `system.heartbeat:${slot}`, payload: {} });
  }
  if (minute === 5) {
    const hourStart = new Date(t - 3_600_000);
    hourStart.setUTCMinutes(0, 0, 0);
    jobs.push({ type: "rollup.hourly", jobId: `rollup.hourly:${hourStart.toISOString()}`, payload: { hourStart: hourStart.toISOString() } });
  }
  if (hour === 0 && minute === 6) {
    const dayStart = new Date(t);
    dayStart.setUTCHours(0, 0, 0, 0);
    const previousDay = new Date(dayStart.getTime() - 86_400_000);
    jobs.push({ type: "rollup.daily", jobId: `rollup.daily:${previousDay.toISOString()}`, payload: { dayStart: previousDay.toISOString() } });
  }
  if (hour === 0 && minute === 7) {
    const today = new Date(t);
    today.setUTCHours(0, 0, 0, 0);
    jobs.push({ type: "retention.cleanup", jobId: `retention.cleanup:${today.toISOString()}`, payload: {} });
  }
  return jobs;
}

export async function runSchedulerTick(deps: SchedulerDeps): Promise<SchedulerTickResult> {
  const startedAt = Date.now();
  const slot = minuteSlot(deps.now ?? new Date());
  const db = getDb(deps.env);
  const producer = new QueueProducer(deps.queue);
  const pageSize = deps.pageSize ?? DUE_PAGE_SIZE;

  await touchSchedulerHeartbeat(deps.env);

  let dueMonitorCount = 0;
  let enqueuedCount = 0;
  let failedBatchCount = 0;

  // Keyset pagination over the due set (§36: paginate due monitors, never
  // execute all of them in one invocation). Successfully enqueued monitors
  // move past the slot boundary, so pages never overlap.
  let cursor: { nextCheckAt: string; id: string } | null = null;
  for (;;) {
    const conditions: SQL[] = [
      eq(monitors.enabled, 1),
      isNull(monitors.archivedAt),
      lte(monitors.nextCheckAt, slot),
    ];
    if (cursor) {
      conditions.push(
        or(
          gt(monitors.nextCheckAt, cursor.nextCheckAt),
          and(eq(monitors.nextCheckAt, cursor.nextCheckAt), gt(monitors.id, cursor.id)),
        ) as SQL,
      );
    }

    const due = await db
      .select({
        id: monitors.id,
        intervalSeconds: monitors.intervalSeconds,
        nextCheckAt: monitors.nextCheckAt,
      })
      .from(monitors)
      .where(and(...conditions))
      .orderBy(asc(monitors.nextCheckAt), asc(monitors.id))
      .limit(pageSize);

    if (due.length === 0) break;
    dueMonitorCount += due.length;

    // Deterministic ids (§15.4): the same (monitor, slot) ALWAYS produces the
    // same job — duplicate scheduler runs enqueue duplicate jobs that the
    // consumer's unique-checkId claim neutralizes (#9).
    const inputs: EnvelopeInput<"monitor.check">[] = due.map((monitor) => ({
      type: "monitor.check",
      jobId: `${monitor.id}:${slot}`,
      payload: {
        monitorId: monitor.id,
        checkId: `${monitor.id}:${slot}`,
        scheduledFor: slot,
        source: "scheduled",
        affectsState: true,
      },
    }));

    let batchEnqueued = false;
    try {
      await producer.sendBatch(inputs);
      enqueuedCount += due.length;
      batchEnqueued = true;
    } catch (error) {
      // §37.7: enqueue failure leaves this batch due — next pass retries.
      failedBatchCount += 1;
      logEvent("scheduler.enqueue_failed", {
        slot,
        batchSize: due.length,
        outcome: "left_due",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (batchEnqueued) {
      const advancements = due.map((monitor) =>
        db
          .update(monitors)
          .set({ nextCheckAt: nextCheckAtFor(monitor.intervalSeconds, slot), updatedAt: new Date().toISOString() })
          .where(eq(monitors.id, monitor.id)),
      );
      // due.length > 0 is guaranteed by the loop break above; the destructured
      // spread gives drizzle's batch the non-empty tuple type it requires.
      const [firstAdvancement, ...restAdvancements] = advancements;
      try {
        await db.batch([firstAdvancement, ...restAdvancements] as const);
      } catch (error) {
        // Enqueued work stays due → the next pass re-enqueues under its NEW
        // slot id (a benign duplicate check); never lose the summary row or
        // the housekeeping dispatch to this failure.
        failedBatchCount += 1;
        logEvent("scheduler.advance_failed", {
          slot,
          monitorCount: due.length,
          outcome: "still_due",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (due.length < pageSize) break;
    const last = due[due.length - 1];
    cursor = { nextCheckAt: last.nextCheckAt, id: last.id };
  }

  // Housekeeping dispatch (§37.8): every job isolated — a failure here is
  // logged and reported but cannot skip or undo monitor scheduling above.
  const housekeeping: HousekeepingDispatch[] = [];
  const housekeepingFailures: HousekeepingDispatch[] = [];
  for (const job of housekeepingJobsForSlot(slot)) {
    try {
      await producer.send(job);
      housekeeping.push({ type: job.type, jobId: job.jobId });
    } catch (error) {
      housekeepingFailures.push({ type: job.type, jobId: job.jobId });
      logEvent("scheduler.housekeeping_failed", {
        slot,
        jobId: job.jobId,
        type: job.type,
        outcome: "dispatch_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  const runId = newId("schrun");
  await db.insert(schedulerRuns).values({
    id: runId,
    scheduledAt: slot,
    dueMonitorCount,
    enqueuedCount,
    failedBatchCount,
    durationMs,
    createdAt: new Date().toISOString(),
  });

  logEvent("scheduler.run", {
    slot,
    due: dueMonitorCount,
    enqueued: enqueuedCount,
    failedBatches: failedBatchCount,
    housekeeping: housekeeping.length,
    housekeepingFailures: housekeepingFailures.length,
    durationMs,
    outcome: failedBatchCount > 0 ? "partial" : "ok",
  });

  return {
    slot,
    runId,
    dueMonitorCount,
    enqueuedCount,
    failedBatchCount,
    durationMs,
    housekeeping,
    housekeepingFailures,
  };
}
