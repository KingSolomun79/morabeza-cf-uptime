/**
 * Hourly/daily rollups (issue #18; PRD §17.10–§17.11, §26, §18).
 *
 * Aggregates eligible check results into `hourly_rollups` / `daily_rollups`
 * so 24h–90d uptime queries stay fast after raw history expires (#19/#20).
 *
 * Eligibility filter (PRD §26 — used verbatim everywhere downstream):
 *   source='scheduled' AND maintenance_excluded=0 AND affects_state=1.
 * Manual and maintenance-excluded results never appear in rollups.
 *
 * Recompute semantics (differ from the #9 claim-once pattern on purpose):
 * rollup jobs are UPSERTED (`.onConflictDoUpdate`) — a re-delivered job for a
 * slot recomputes from `check_results` and overwrites, so late-arriving raw
 * rows are folded in and the gotcha-8 ordering race (daily consumed before
 * the 23:xx hourly) is harmless: daily NEVER sums hourly rows.
 *
 * Determinism: everything is derived from completed_at windows
 * (`>= start AND < end`, lexicographic on ms-precision UTC ISO) and stored
 * incident columns — a re-run for the same slot produces byte-identical rows.
 * Still-open incidents clip their downtime to the window end (not "now"), so
 * even later recomputes of a past day stay stable.
 *
 * Response-time aggregates: min/max over non-NULL response_time_ms (failed
 * checks may carry NULL); avg is stored as the unrounded REAL — presentation
 * rounds at the edge (#20/#22), the PRD pins no rollup-side rounding.
 */
import { and, gte, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { checkResults, dailyRollups, hourlyRollups, incidents } from "../../db/schema";
import type { AppDatabase } from "../lib/db";
import { eligibleCheckConditions } from "./uptime";

type RollupWrite = BatchItem<"sqlite">;

/** D1-friendly write chunk (§36 mindset; mirrors the scheduler's page size). */
const WRITE_CHUNK = 100;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Per-monitor hourly/daily aggregate shape (§17.10/§17.11 shared columns). */
interface RollupValues {
  monitorId: string;
  eligibleChecks: number;
  upChecks: number;
  downChecks: number;
  avgResponseTimeMs: number | null;
  minResponseTimeMs: number | null;
  maxResponseTimeMs: number | null;
}

interface IncidentOverlap {
  monitorId: string;
  openedAt: string;
  resolvedAt: string | null;
}

/** Coerces D1 numeric aggregates (count/sum/avg can arrive as strings). */
function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

/**
 * Aggregates eligible checks per monitor over `[windowStart, windowEnd)` —
 * computed from RAW check_results, never from lower-granularity rollups.
 */
async function aggregateChecks(
  db: AppDatabase,
  windowStart: string,
  windowEnd: string,
): Promise<RollupValues[]> {
  const rows = await db
    .select({
      monitorId: checkResults.monitorId,
      eligible: sql<number>`count(*)`,
      up: sql<number>`coalesce(sum(${checkResults.isHealthy}), 0)`,
      avgResponse: sql<number | null>`avg(${checkResults.responseTimeMs})`,
      minResponse: sql<number | null>`min(${checkResults.responseTimeMs})`,
      maxResponse: sql<number | null>`max(${checkResults.responseTimeMs})`,
    })
    .from(checkResults)
    .where(
      and(
        ...eligibleCheckConditions(null),
        // Lexicographic comparisons are safe on ms-precision UTC ISO text.
        gte(checkResults.completedAt, windowStart),
        lt(checkResults.completedAt, windowEnd),
      ),
    )
    .groupBy(checkResults.monitorId);

  return rows.map((row) => {
    const eligible = toNumber(row.eligible);
    const up = toNumber(row.up);
    return {
      monitorId: row.monitorId,
      eligibleChecks: eligible,
      upChecks: up,
      downChecks: eligible - up,
      avgResponseTimeMs: row.avgResponse === null ? null : Number(row.avgResponse),
      minResponseTimeMs: row.minResponse === null ? null : Number(row.minResponse),
      maxResponseTimeMs: row.maxResponse === null ? null : Number(row.maxResponse),
    };
  });
}

/**
 * Downtime semantics (documented choice for #18): a day's `downtime_ms` is
 * the overlap of every incident's [opened_at, resolved_at) span with the day
 * window — not a raw sum of `outage_duration_ms`. This keeps re-runs
 * deterministic (open incidents clip to window END, never "now") and splits
 * cross-midnight outages truthfully across days. `incident_count` counts
 * incidents OPENED in the window only; carry-over incidents contribute
 * downtime without inflating the count.
 */
function overlapForDay(incident: IncidentOverlap, windowStartMs: number, windowEndMs: number): number {
  const openedMs = Date.parse(incident.openedAt);
  const resolvedMs = incident.resolvedAt === null ? Number.POSITIVE_INFINITY : Date.parse(incident.resolvedAt);
  const start = Math.max(openedMs, windowStartMs);
  const end = Math.min(resolvedMs, windowEndMs);
  return Math.max(0, end - start);
}

async function fetchOverlappingIncidents(db: AppDatabase, windowStart: string, windowEnd: string): Promise<IncidentOverlap[]> {
  return db
    .select({
      monitorId: incidents.monitorId,
      openedAt: incidents.openedAt,
      resolvedAt: incidents.resolvedAt,
    })
    .from(incidents)
    .where(
      and(
        // Opened before the window ends (any part of the outage touches it).
        lt(incidents.openedAt, windowEnd),
        // And not fully resolved before it begins. INVARIANT: every close
        // path (recovered, monitor_disabled, admin) sets resolved_at
        // (services/incidents.ts, repositories/monitors.ts) — only genuinely
        // open incidents have NULL. If a future close path stops setting it,
        // this query would accrue downtime for that incident forever.
        or(isNull(incidents.resolvedAt), gt(incidents.resolvedAt, windowStart)),
      ),
    );
}

interface DayIncidentTotals {
  incidentCount: number;
  downtimeMs: number;
}

function totalsByMonitor(
  overlaps: IncidentOverlap[],
  windowStartMs: number,
  windowEndMs: number,
): Map<string, DayIncidentTotals> {
  const totals = new Map<string, DayIncidentTotals>();
  for (const incident of overlaps) {
    const entry = totals.get(incident.monitorId) ?? { incidentCount: 0, downtimeMs: 0 };
    entry.downtimeMs += overlapForDay(incident, windowStartMs, windowEndMs);
    const openedMs = Date.parse(incident.openedAt);
    if (openedMs >= windowStartMs && openedMs < windowEndMs) {
      entry.incidentCount += 1;
    }
    totals.set(incident.monitorId, entry);
  }
  return totals;
}

/** Batches write statements in D1-friendly chunks (non-empty tuple contract). */
async function batchWrites(db: AppDatabase, statements: RollupWrite[]): Promise<void> {
  for (let i = 0; i < statements.length; i += WRITE_CHUNK) {
    const chunk = statements.slice(i, i + WRITE_CHUNK);
    const [first, ...rest] = chunk;
    await db.batch([first, ...rest] as const);
  }
}

export interface HourlyRollupResult {
  hourStart: string;
  monitorsAggregated: number;
}

/**
 * Recomputes and upserts `hourly_rollups` for the hour starting at
 * `hourStart` (normalized to the UTC hour by the caller). Monitors with zero
 * eligible checks in the window get NO row (absence = no_data for #20).
 */
export async function computeHourlyRollups(db: AppDatabase, hourStart: string): Promise<HourlyRollupResult> {
  const windowEnd = new Date(Date.parse(hourStart) + HOUR_MS).toISOString();
  const rollups = await aggregateChecks(db, hourStart, windowEnd);

  const statements = rollups.map((rollup) =>
    db
      .insert(hourlyRollups)
      .values({ ...rollup, hourStart })
      .onConflictDoUpdate({
        target: [hourlyRollups.monitorId, hourlyRollups.hourStart],
        // Recompute-and-overwrite (NOT claim-once): late raw rows fold in.
        set: {
          eligibleChecks: rollup.eligibleChecks,
          upChecks: rollup.upChecks,
          downChecks: rollup.downChecks,
          avgResponseTimeMs: rollup.avgResponseTimeMs,
          minResponseTimeMs: rollup.minResponseTimeMs,
          maxResponseTimeMs: rollup.maxResponseTimeMs,
        },
      }),
  );
  await batchWrites(db, statements);

  return { hourStart, monitorsAggregated: rollups.length };
}

export interface DailyRollupResult {
  dayStart: string;
  monitorsAggregated: number;
  /** Summed incident_count across written rows (for the structured log). */
  incidentsCounted: number;
  /** Summed downtime_ms across written rows (for the structured log). */
  downtimeMs: number;
}

/**
 * Recomputes and upserts `daily_rollups` for the UTC day starting at
 * `dayStart`, plus `incident_count` / `downtime_ms` (see overlap semantics
 * above). Rollup rows are only written for monitors with eligible checks —
 * incident-only monitors (paused mid-day) intentionally produce no row, so
 * #20 reports no_data rather than a zero-check day.
 */
export async function computeDailyRollups(db: AppDatabase, dayStart: string): Promise<DailyRollupResult> {
  const windowEnd = new Date(Date.parse(dayStart) + DAY_MS).toISOString();
  const windowStartMs = Date.parse(dayStart);
  const windowEndMs = Date.parse(windowEnd);

  const [rollups, overlaps] = await Promise.all([
    aggregateChecks(db, dayStart, windowEnd),
    fetchOverlappingIncidents(db, dayStart, windowEnd),
  ]);
  const incidentTotals = totalsByMonitor(overlaps, windowStartMs, windowEndMs);

  let incidentsCounted = 0;
  let downtimeMs = 0;
  const statements = rollups.map((rollup) => {
    const totals = incidentTotals.get(rollup.monitorId) ?? { incidentCount: 0, downtimeMs: 0 };
    incidentsCounted += totals.incidentCount;
    downtimeMs += totals.downtimeMs;
    const values = { ...rollup, dayStart, incidentCount: totals.incidentCount, downtimeMs: totals.downtimeMs };
    return db
      .insert(dailyRollups)
      .values(values)
      .onConflictDoUpdate({
        target: [dailyRollups.monitorId, dailyRollups.dayStart],
        set: {
          eligibleChecks: values.eligibleChecks,
          upChecks: values.upChecks,
          downChecks: values.downChecks,
          avgResponseTimeMs: values.avgResponseTimeMs,
          minResponseTimeMs: values.minResponseTimeMs,
          maxResponseTimeMs: values.maxResponseTimeMs,
          incidentCount: values.incidentCount,
          downtimeMs: values.downtimeMs,
        },
      });
  });
  await batchWrites(db, statements);

  return { dayStart, monitorsAggregated: rollups.length, incidentsCounted, downtimeMs };
}
