/**
 * Retention cleanup (issue #19; PRD §18).
 *
 * Deletes expired rows in BOUNDED batches — never one unbounded statement —
 * so D1 stays small and fast as raw history grows (§36). Tables and windows:
 *
 *   check_results     RAW_CHECK_RETENTION_DAYS (default 7d)   by completed_at
 *   scheduler_runs    fixed 7d (not configurable)             by created_at
 *   hourly_rollups    HOURLY_RETENTION_DAYS (default 90d)     by hour_start
 *   daily_rollups     DAILY_RETENTION_DAYS (default 730d)     by day_start
 *   dead_letter_events (RESOLVED rows only)                   by resolved_at
 *
 * Never touched: monitors, incidents, maintenance_windows (§18 "retain") and
 * notification_events / audit_events (§18 "retain at least 365 days" — this
 * job deletes nothing from them; a future archiver would own that policy).
 *
 * Dead-letter policy (issue #19 asked for a documented choice): unresolved
 * rows are retained FOREVER (they are actionable); resolved rows follow a
 * 30-day operational retention. `resolved_at < cutoff` is NULL-safe, so
 * unresolved rows can never match.
 *
 * Batch shape (D1-friendly): `DELETE FROM t WHERE keys IN (SELECT keys FROM t
 * WHERE age < ? LIMIT batch)` looped until a partial batch — every statement
 * is bounded by LIMIT, and `meta.changes` gives exact per-batch counts.
 *
 * Idempotent by construction: the job runs against a time-derived boundary,
 * so a re-delivery finds nothing left past the cutoff and deletes 0 rows.
 * Raw check_results are pruned wholesale by age (manual + maintenance rows
 * included) per PRD §18's table-level retention and the issue's spec reading.
 */
import { sql } from "drizzle-orm";
import type { AppDatabase } from "../lib/db";
import { nowIso } from "../lib/time";

export const DEFAULT_RAW_CHECK_RETENTION_DAYS = 7;
export const DEFAULT_HOURLY_RETENTION_DAYS = 90;
export const DEFAULT_DAILY_RETENTION_DAYS = 730;
/** PRD §18: scheduler_runs keep this table short-retention — fixed 7d. */
export const SCHEDULER_RUNS_RETENTION_DAYS = 7;
/** Operational retention for RESOLVED dead_letter_events (see header). */
export const RESOLVED_DLQ_RETENTION_DAYS = 30;

/** Rows deleted per bounded statement (issue AC: no unbounded deletes). */
export const RETENTION_BATCH_SIZE = 500;
/**
 * Safety cap: batches per table per run (500 × 10_000 = 5M rows). A backlog
 * larger than this continues on the next daily run instead of looping
 * unbounded inside one delivery.
 */
const MAX_BATCHES_PER_TABLE = 10_000;

const DAY_MS = 86_400_000;

/**
 * Parses a wrangler `vars` value (string) into a positive integer day count.
 * Absent/empty → §18 default; anything else that is not plain digits fails
 * loud so the operator sees it in the DLQ instead of discovering
 * wrong-sized history (rejects "7.5", "0", "-3", "0x10", "1e2", " 7").
 *
 * Shared by the retention handler (#19) and the uptime switchover (#20) so
 * retention and uptime can never disagree about the raw window.
 */
export function parseRetentionDays(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`retention vars: ${name}="${raw}" is not a positive integer`);
  }
  const parsed = Number(raw);
  if (parsed < 1) {
    throw new Error(`retention vars: ${name}="${raw}" is not a positive integer`);
  }
  return parsed;
}

/** Configurable windows (the fixed policies live as constants above). */
export interface RetentionWindows {
  rawCheckDays: number;
  hourlyDays: number;
  dailyDays: number;
}

export interface RetentionSummary {
  ranAt: string;
  /** UTC ISO cutoff applied per table (rows strictly older were deleted). */
  cutoffs: {
    checkResults: string;
    schedulerRuns: string;
    hourlyRollups: string;
    dailyRollups: string;
    resolvedDeadLetters: string;
  };
  deleted: {
    checkResults: number;
    schedulerRuns: number;
    hourlyRollups: number;
    dailyRollups: number;
    resolvedDeadLetters: number;
  };
}

interface BoundedDeleteTarget {
  table: string;
  /** Composite keys allowed — hourly/daily rollups have (monitor_id, *_start). */
  keyColumns: string[];
  /** The age column driving expiry. */
  filterColumn: string;
  cutoff: string;
}

/**
 * Loops the bounded DELETE until a partial (or empty) batch reports the table
 * exhausted. SQLite `IN` with a row-value subselect covers composite keys;
 * NULL age values (unresolved dead letters) never match `<`.
 */
async function deleteExpiredBatches(
  db: AppDatabase,
  target: BoundedDeleteTarget,
  batchSize: number,
): Promise<number> {
  const keys = sql.raw(target.keyColumns.join(", "));
  const table = sql.raw(target.table);
  const ageColumn = sql.raw(target.filterColumn);
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
    const result = await db.run(sql`
      DELETE FROM ${table}
      WHERE (${keys}) IN (
        SELECT ${keys} FROM ${table}
        WHERE ${ageColumn} < ${target.cutoff}
        LIMIT ${batchSize}
      )
    `);
    const changes = Number(result.meta?.changes ?? 0);
    deleted += changes;
    if (changes < batchSize) break; // empty or partial batch → table exhausted
  }
  return deleted;
}

export async function runRetentionCleanup(
  db: AppDatabase,
  windows: RetentionWindows,
  opts: { now?: string; batchSize?: number } = {},
): Promise<RetentionSummary> {  const ranAt = opts.now ?? nowIso();
  const batchSize = opts.batchSize ?? RETENTION_BATCH_SIZE;
  const cutoff = (days: number) => new Date(Date.parse(ranAt) - days * DAY_MS).toISOString();

  const targets: Record<keyof RetentionSummary["deleted"], BoundedDeleteTarget> = {
    checkResults: {
      table: "check_results",
      keyColumns: ["id"],
      filterColumn: "completed_at",
      cutoff: cutoff(windows.rawCheckDays),
    },
    schedulerRuns: {
      table: "scheduler_runs",
      keyColumns: ["id"],
      filterColumn: "created_at",
      cutoff: cutoff(SCHEDULER_RUNS_RETENTION_DAYS),
    },
    hourlyRollups: {
      table: "hourly_rollups",
      keyColumns: ["monitor_id", "hour_start"],
      filterColumn: "hour_start",
      cutoff: cutoff(windows.hourlyDays),
    },
    dailyRollups: {
      table: "daily_rollups",
      keyColumns: ["monitor_id", "day_start"],
      filterColumn: "day_start",
      cutoff: cutoff(windows.dailyDays),
    },
    resolvedDeadLetters: {
      table: "dead_letter_events",
      keyColumns: ["id"],
      filterColumn: "resolved_at", // NULL (unresolved) never matches `<`
      cutoff: cutoff(RESOLVED_DLQ_RETENTION_DAYS),
    },
  };

  const deleted = {
    checkResults: 0,
    schedulerRuns: 0,
    hourlyRollups: 0,
    dailyRollups: 0,
    resolvedDeadLetters: 0,
  } as RetentionSummary["deleted"];
  for (const [key, target] of Object.entries(targets) as Array<[keyof RetentionSummary["deleted"], BoundedDeleteTarget]>) {
    deleted[key] = await deleteExpiredBatches(db, target, batchSize);
  }

  return {
    ranAt,
    cutoffs: {
      checkResults: targets.checkResults.cutoff,
      schedulerRuns: targets.schedulerRuns.cutoff,
      hourlyRollups: targets.hourlyRollups.cutoff,
      dailyRollups: targets.dailyRollups.cutoff,
      resolvedDeadLetters: targets.resolvedDeadLetters.cutoff,
    },
    deleted,
  };
}
