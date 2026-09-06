/**
 * Uptime calculations (issue #20; PRD §24, §26, §36, §32.1).
 *
 * `percentage = healthy eligible / total eligible * 100` where eligibility is
 * the §26 law used verbatim downstream of the pipeline:
 *   source='scheduled' AND maintenance_excluded=0 AND affects_state=1
 * and healthy = is_healthy=1. Manual checks never count; paused intervals
 * simply contribute no eligible checks — zero eligible in the window means
 * explicit `no_data`, NEVER 100%.
 *
 * Source strategy (window anchored at now):
 * - raw `check_results` while the window start is inside raw retention;
 * - `hourly_rollups` for the older span;
 * - "blended" when a window straddles the raw-retention boundary (the normal
 *   case for 30d/90d under §18's 7d raw default).
 * The switchover derives from RAW_CHECK_RETENTION_DAYS (#19 var) via the
 * shared `parseRetentionDays` so retention and uptime can never disagree.
 * ASSUMPTION (documented for #22/#24): HOURLY_RETENTION_DAYS (§18 default
 * 90d) covers every window's rollup span — an operator who shrinks it below
 * that silently narrows the rollup coverage of 30d/90d windows. Falling back
 * to daily_rollups for hours beyond hourly retention is a deliberate
 * non-feature here; revisit before shrinking those vars in production.
 *
 * Blend boundary alignment: rollup hours participate WHOLE. The raw/rollup
 * switchover is aligned DOWN to the hour — rollups own every hour strictly
 * before it, raw owns [it, now] — so no check is double-counted or dropped,
 * whatever its timestamp. The window's first (possibly partial) hour is
 * included from the rollups as well; an hour that intersects the span
 * contributes fully. Exact ms-precision agreement between the two paths
 * therefore holds only for hour-aligned fixtures — which is the honest
 * granularity of hourly aggregates (§32.1 fixtures align to hours).
 *
 * Math: counts are summed across slices (weighted by eligible_checks — never
 * an average of percentages) at full precision; rounding to 2 decimals
 * happens once, here, at the edge.
 *
 * Source "rollup" (no raw coverage at all) cannot occur for now-anchored
 * windows — `now` is always inside raw retention — so a straddling window is
 * always "blended" and an in-retention window always "raw". The literal is
 * kept in the result type to match PRD §24's three-way wording.
 *
 * Queries are index-only shaped (§36): raw via
 * check_results_monitor_completed_idx (monitor_id, completed_at), rollups
 * via the (monitor_id, hour_start) primary key.
 */
import { and, eq, gte, lt, lte, sql } from "drizzle-orm";
import { checkResults, hourlyRollups } from "../../db/schema";
import { getDb } from "../lib/db";
import type { AppDatabase } from "../lib/db";
import { nowIso } from "../lib/time";
import { DEFAULT_RAW_CHECK_RETENTION_DAYS, parseRetentionDays } from "./retention";
import type { Env } from "../env";

export const UPTIME_WINDOWS = ["24h", "7d", "30d", "90d"] as const;
export type UptimeWindow = (typeof UPTIME_WINDOWS)[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const WINDOW_MS: Record<UptimeWindow, number> = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
};

export interface UptimeResult {
  monitorId: string;
  window: UptimeWindow;
  /** "no_data" when the window holds zero eligible checks (§26). */
  status: "ok" | "no_data";
  /** Healthy/eligible × 100 rounded to 2 decimals; null when no_data. */
  percentage: number | null;
  eligibleChecks: number;
  healthyChecks: number;
  source: "raw" | "rollup" | "blended";
}

interface SliceCounts {
  eligible: number;
  healthy: number;
}

/** Resolves the raw-retention switchover (#19 var, §18 default 7 days). */
export function resolveRawRetentionDays(env: Env): number {
  return parseRetentionDays(env.RAW_CHECK_RETENTION_DAYS, "RAW_CHECK_RETENTION_DAYS", DEFAULT_RAW_CHECK_RETENTION_DAYS);
}

/** Coerces D1 numeric aggregates (count/sum can arrive as strings). */
function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

async function rawSliceCounts(
  db: AppDatabase,
  monitorId: string,
  windowStart: string,
  windowEnd: string,
): Promise<SliceCounts> {
  const [row] = await db
    .select({
      eligible: sql<number>`count(*)`,
      healthy: sql<number>`coalesce(sum(${checkResults.isHealthy}), 0)`,
    })
    .from(checkResults)
    .where(
      and(
        eq(checkResults.monitorId, monitorId),
        // §26 eligibility, verbatim.
        eq(checkResults.source, "scheduled"),
        eq(checkResults.maintenanceExcluded, 0),
        eq(checkResults.affectsState, 1),
        gte(checkResults.completedAt, windowStart),
        lte(checkResults.completedAt, windowEnd),
      ),
    );
  return { eligible: toNumber(row?.eligible), healthy: toNumber(row?.healthy) };
}

async function rollupSliceCounts(
  db: AppDatabase,
  monitorId: string,
  windowStart: string,
  rollupTo: string,
): Promise<SliceCounts> {
  const [row] = await db
    .select({
      eligible: sql<number>`coalesce(sum(${hourlyRollups.eligibleChecks}), 0)`,
      healthy: sql<number>`coalesce(sum(${hourlyRollups.upChecks}), 0)`,
    })
    .from(hourlyRollups)
    .where(
      and(
        eq(hourlyRollups.monitorId, monitorId),
        gte(hourlyRollups.hourStart, windowStart),
        lt(hourlyRollups.hourStart, rollupTo),
      ),
    );
  return { eligible: toNumber(row?.eligible), healthy: toNumber(row?.healthy) };
}

export async function computeUptime(
  db: AppDatabase,
  monitorId: string,
  window: UptimeWindow,
  opts: { windowEnd: string; rawCheckDays: number },
): Promise<UptimeResult> {
  const windowEndMs = Date.parse(opts.windowEnd);
  if (Number.isNaN(windowEndMs)) {
    throw new Error(`uptime: unparseable window end "${opts.windowEnd}"`);
  }
  const windowStartMs = windowEndMs - WINDOW_MS[window];
  const rawCutoffMs = windowEndMs - opts.rawCheckDays * DAY_MS;

  const blended = windowStartMs < rawCutoffMs;
  // Rollup hours participate WHOLE: the switchover is aligned down to the
  // hour (rollups own hours strictly before it — no overlap with the raw
  // span) and the window's first hour is included even when the window starts
  // mid-hour, so a boundary hour's checks are never dropped. Structurally
  // switchover >= windowStartHour always holds (integer-day retention vs
  // day-multiple windows, both floored to the hour), so the raw slice can
  // never reach below the window.
  const switchoverMs = Math.floor(rawCutoffMs / HOUR_MS) * HOUR_MS;
  const windowStartHourMs = Math.floor(windowStartMs / HOUR_MS) * HOUR_MS;
  const switchover = new Date(switchoverMs).toISOString();
  const windowStartHour = new Date(windowStartHourMs).toISOString();

  const raw = await rawSliceCounts(
    db,
    monitorId,
    blended ? switchover : new Date(windowStartMs).toISOString(),
    opts.windowEnd,
  );
  const rollup = blended
    ? await rollupSliceCounts(db, monitorId, windowStartHour, switchover)
    : { eligible: 0, healthy: 0 };

  const eligibleChecks = raw.eligible + rollup.eligible;
  const healthyChecks = raw.healthy + rollup.healthy;
  const status = eligibleChecks === 0 ? "no_data" : "ok";

  return {
    monitorId,
    window,
    status,
    percentage:
      eligibleChecks === 0 ? null : Math.round((healthyChecks / eligibleChecks) * 100 * 100) / 100,
    eligibleChecks,
    healthyChecks,
    source: blended ? "blended" : "raw",
  };
}

/** Env-facing entry point used by the route (resolves vars + clock). */
export async function getMonitorUptime(
  env: Env,
  monitorId: string,
  window: UptimeWindow,
  opts: { now?: string } = {},
): Promise<UptimeResult> {
  return computeUptime(getDb(env), monitorId, window, {
    windowEnd: opts.now ?? nowIso(),
    rawCheckDays: resolveRawRetentionDays(env),
  });
}
