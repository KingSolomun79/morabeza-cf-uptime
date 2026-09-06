/**
 * rollup.hourly / rollup.daily job handlers (issue #18; PRD §17.10–§17.11,
 * §18, §26).
 *
 * Dispatch arrives from the #10 scheduler (hourly at :05 for the previous
 * hour; daily at 00:06 UTC for the previous day). Handlers are thin:
 *  1. normalize the window start from the payload (canonical UTC hour/day
 *     start) — a malformed value THROWS so the consumer retries → DLQ
 *     (fail loud, never silently aggregate a wrong window);
 *  2. recompute + upsert the rollup rows from raw check_results
 *     (services/rollups.ts — idempotent recompute, NOT claim-once);
 *  3. touch the rollup heartbeat on success only;
 *  4. one structured summary log (PRD §28).
 *
 * A failing rollup never blocks monitor scheduling: it is an independent
 * queue message (§37.8) — a throw only schedules THIS message for retry.
 */
import { getDb } from "../../lib/db";
import { logEvent } from "../../lib/logging";
import { nowIso } from "../../lib/time";
import { computeDailyRollups, computeHourlyRollups } from "../../services/rollups";
import { touchDailyRollupHeartbeat, touchHourlyRollupHeartbeat } from "../../repositories/system";
import type { JobContext, JobHandler } from "../consumer";

/**
 * Validates that the payload carries the CANONICAL UTC hour/day start
 * (ms precision, exactly as housekeepingJobsForSlot emits it) and returns it.
 * Non-canonical input THROWS → retry → DLQ: silently truncating to the
 * canonical window would mask a buggy producer, and the upsert key must stay
 * aligned with the deterministic jobId.
 */
function normalizeWindowStart(raw: string, mode: "hour" | "day", jobType: string): string {
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`${jobType}: unparseable window start "${raw}"`);
  }
  const date = new Date(parsed);
  if (mode === "hour") {
    date.setUTCMinutes(0, 0, 0);
  } else {
    date.setUTCHours(0, 0, 0, 0);
  }
  const canonical = date.toISOString();
  if (canonical !== raw) {
    throw new Error(`${jobType}: window start "${raw}" is not canonical (${canonical})`);
  }
  return canonical;
}

export function createHourlyRollupHandler(): JobHandler<"rollup.hourly"> {
  return async (payload, ctx: JobContext) => {
    const hourStart = normalizeWindowStart(payload.hourStart, "hour", "rollup.hourly");
    const result = await computeHourlyRollups(getDb(ctx.env), hourStart);
    await touchHourlyRollupHeartbeat(ctx.env, nowIso());
    logEvent("rollup.hourly_completed", {
      jobId: ctx.jobId,
      hourStart: result.hourStart,
      monitors: result.monitorsAggregated,
      outcome: "ok",
    });
  };
}

export function createDailyRollupHandler(): JobHandler<"rollup.daily"> {
  return async (payload, ctx: JobContext) => {
    const dayStart = normalizeWindowStart(payload.dayStart, "day", "rollup.daily");
    const result = await computeDailyRollups(getDb(ctx.env), dayStart);
    await touchDailyRollupHeartbeat(ctx.env, nowIso());
    logEvent("rollup.daily_completed", {
      jobId: ctx.jobId,
      dayStart: result.dayStart,
      monitors: result.monitorsAggregated,
      incidents: result.incidentsCounted,
      downtimeMs: result.downtimeMs,
      outcome: "ok",
    });
  };
}
