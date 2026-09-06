/**
 * retention.cleanup job handler (issue #19; PRD §18, §28).
 *
 * The #10 scheduler dispatches once per UTC day at 00:07 with an empty
 * payload `{}`; the deterministic jobId carries the UTC date. The run
 * boundary is derived from `nowIso()` inside the handler — a re-delivery for
 * the same day finds nothing left past the cutoff and harmlessly deletes 0
 * rows (idempotent by construction).
 *
 * Sequence:
 *  1. parse the optional retention vars (§18 defaults when absent); a
 *     present-but-invalid value THROWS → retry → DLQ (fail loud, never
 *     silently misprune);
 *  2. run the bounded batched deletes (services/retention.ts);
 *  3. touch `last_cleanup_at` on success only;
 *  4. one structured summary log with deletion counts (PRD §28).
 */
import { getDb } from "../../lib/db";
import { logEvent } from "../../lib/logging";
import { nowIso } from "../../lib/time";
import {
  DEFAULT_DAILY_RETENTION_DAYS,
  DEFAULT_HOURLY_RETENTION_DAYS,
  DEFAULT_RAW_CHECK_RETENTION_DAYS,
  runRetentionCleanup,
  type RetentionWindows,
} from "../../services/retention";
import { touchCleanupHeartbeat } from "../../repositories/system";
import type { Env } from "../../env";
import type { JobContext, JobHandler } from "../consumer";

/**
 * Parses a wrangler `vars` value (string) into a positive integer day count.
 * Absent/empty → §18 default; anything else that is not plain digits fails
 * loud so the operator sees it in the DLQ instead of discovering
 * wrong-sized history (rejects "7.5", "0", "-3", "0x10", "1e2", " 7").
 */
export function parseRetentionDays(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`retention.cleanup: ${name}="${raw}" is not a positive integer`);
  }
  const parsed = Number(raw);
  if (parsed < 1) {
    throw new Error(`retention.cleanup: ${name}="${raw}" is not a positive integer`);
  }
  return parsed;
}

export function createRetentionCleanupHandler(): JobHandler<"retention.cleanup"> {
  return async (_payload, ctx: JobContext) => {
    const env: Env = ctx.env;
    const windows: RetentionWindows = {
      rawCheckDays: parseRetentionDays(env.RAW_CHECK_RETENTION_DAYS, "RAW_CHECK_RETENTION_DAYS", DEFAULT_RAW_CHECK_RETENTION_DAYS),
      hourlyDays: parseRetentionDays(env.HOURLY_RETENTION_DAYS, "HOURLY_RETENTION_DAYS", DEFAULT_HOURLY_RETENTION_DAYS),
      dailyDays: parseRetentionDays(env.DAILY_RETENTION_DAYS, "DAILY_RETENTION_DAYS", DEFAULT_DAILY_RETENTION_DAYS),
    };

    const summary = await runRetentionCleanup(getDb(env), windows);
    await touchCleanupHeartbeat(env, nowIso());
    logEvent("retention.cleanup_completed", {
      jobId: ctx.jobId,
      ranAt: summary.ranAt,
      deletedCheckResults: summary.deleted.checkResults,
      deletedSchedulerRuns: summary.deleted.schedulerRuns,
      deletedHourlyRollups: summary.deleted.hourlyRollups,
      deletedDailyRollups: summary.deleted.dailyRollups,
      deletedResolvedDeadLetters: summary.deleted.resolvedDeadLetters,
      outcome: "ok",
    });
  };
}
