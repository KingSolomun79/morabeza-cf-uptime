/**
 * Dashboard aggregation (issue #22; PRD §24, §27.3, §36).
 *
 * One aggregate response for the Overview page: status counts, maintenance
 * count, open incidents, recent recoveries, response-time trend from
 * hourly rollups, heartbeat summary, and the primary monitor table rows
 * (Client | Monitor | Status | 24h uptime | Last response | Last check |
 * Incident).
 *
 * Query budget is FIXED regardless of fleet size (§36) — no per-monitor
 * history fetches:
 *   1. monitors ⟕ monitor_state ⟕ clients (one join);
 *   2. active maintenance windows (membership computed in JS);
 *   3. open incidents;
 *   4. recent resolved incidents (LIMIT 5);
 *   5. 24h response-time trend, one grouped aggregate over hourly_rollups
 *      (weighted by eligible_checks, never an average of averages);
 *   6. 24h §26-eligible check counts grouped by monitor (services/uptime);
 *   + the #11 heartbeat evaluation (its own single system_state read).
 *
 * 24h uptime reuse (#20): the grouped slice shares uptime.ts's eligibility
 * builder and 2-decimal rounding semantics. 24h sits inside raw retention
 * under §18 defaults (raw ≥ 1 day), so the raw slice alone is authoritative;
 * with a sub-day RAW_CHECK_RETENTION_DAYS the column can undercount to
 * no_data — an operator-visible tradeoff of shrinking retention that far.
 * Statuses are derived from monitor_state (the state machine's truth), NOT
 * recomputed from checks.
 */
import { and, asc, desc, eq, gt, gte, isNull, lt, sql } from "drizzle-orm";
import { clients, hourlyRollups, incidents, maintenanceWindows, monitorState, monitors } from "../../db/schema";
import { getDb } from "../lib/db";
import { nowIso } from "../lib/time";
import { evaluateHealth } from "./healthz";
import { uptimeCountsByMonitor } from "./uptime";
import type { Env } from "../env";

const DAY_MS = 86_400_000;
/** Recent recoveries listed on the overview (PRD §27.3 "recent"). */
export const RECENT_RECOVERIES_LIMIT = 5;

export interface DashboardMonitorRow {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  /** State-machine truth: up | down | unknown | paused. */
  status: string;
  inMaintenance: boolean;
  uptime24h: { status: "ok" | "no_data"; percentage: number | null; eligibleChecks: number };
  lastResponseTimeMs: number | null;
  lastCheckedAt: string | null;
  openIncidentId: string | null;
}

export interface DashboardTrendPoint {
  hourStart: string;
  avgResponseTimeMs: number;
}

export interface DashboardRecovery {
  id: string;
  monitorId: string;
  monitorName: string;
  resolvedAt: string;
  outageDurationMs: number | null;
}

export interface DashboardDto {
  counts: {
    totalActive: number;
    up: number;
    down: number;
    unknown: number;
    paused: number;
    inMaintenance: number;
    openIncidents: number;
  };
  recentRecoveries: DashboardRecovery[];
  trend: DashboardTrendPoint[];
  heartbeat: {
    status: "ok" | "degraded";
    checks: { d1: boolean; scheduler: boolean; consumer: boolean };
  };
  monitors: DashboardMonitorRow[];
}

/** One round trip for every currently-active maintenance window. */
async function activeWindows(db: ReturnType<typeof getDb>, now: string) {
  return db
    .select({
      scopeType: maintenanceWindows.scopeType,
      scopeId: maintenanceWindows.scopeId,
    })
    .from(maintenanceWindows)
    .where(
      and(
        isNull(maintenanceWindows.cancelledAt),
        lt(maintenanceWindows.startsAt, now),
        gt(maintenanceWindows.endsAt, now),
      ),
    );
}

function windowAppliesTo(
  window: { scopeType: string; scopeId: string | null },
  monitor: { id: string; clientId: string },
): boolean {
  switch (window.scopeType) {
    case "global":
      return true;
    case "client":
      return window.scopeId === monitor.clientId;
    case "monitor":
      return window.scopeId === monitor.id;
    default:
      return false;
  }
}

export async function getDashboard(env: Env, opts: { now?: string } = {}): Promise<DashboardDto> {
  const db = getDb(env);
  const now = opts.now ?? nowIso();
  const dayAgo = new Date(Date.parse(now) - DAY_MS).toISOString();

  // 1) Every active monitor with its state and client name — one join.
  const monitorRows = await db
    .select({
      id: monitors.id,
      clientId: monitors.clientId,
      clientName: clients.name,
      name: monitors.name,
      status: monitorState.status,
      lastResponseTimeMs: monitorState.lastResponseTimeMs,
      lastCheckedAt: monitorState.lastCheckedAt,
    })
    .from(monitors)
    .leftJoin(monitorState, eq(monitorState.monitorId, monitors.id))
    .leftJoin(clients, eq(clients.id, monitors.clientId))
    .where(isNull(monitors.archivedAt))
    .orderBy(asc(monitors.name));

  // 2..5) Fixed-count aggregates.
  const [windows, openIncidentRows, recoveryRows, trendRows, uptimeByMonitor, health] = await Promise.all([
    activeWindows(db, now),
    db
      .select({ id: incidents.id, monitorId: incidents.monitorId })
      .from(incidents)
      .where(eq(incidents.status, "open")),
    db
      .select({
        id: incidents.id,
        monitorId: incidents.monitorId,
        monitorName: monitors.name,
        resolvedAt: incidents.resolvedAt,
        outageDurationMs: incidents.outageDurationMs,
      })
      .from(incidents)
      .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
      .where(and(eq(incidents.status, "resolved"), eq(incidents.resolutionReason, "recovered")))
      .orderBy(desc(incidents.resolvedAt))
      .limit(RECENT_RECOVERIES_LIMIT),
    db
      .select({
        hourStart: hourlyRollups.hourStart,
        // Fleet trend: eligible-weighted mean of per-monitor hour avgs —
        // never a plain average of averages (§27.3 trend from rollups).
        avgResponse: sql<number>`sum(${hourlyRollups.avgResponseTimeMs} * ${hourlyRollups.eligibleChecks}) / sum(${hourlyRollups.eligibleChecks})`,
      })
      .from(hourlyRollups)
      .where(gte(hourlyRollups.hourStart, new Date(Date.parse(now) - DAY_MS).toISOString()))
      .groupBy(hourlyRollups.hourStart)
      .orderBy(asc(hourlyRollups.hourStart)),
    uptimeCountsByMonitor(db, dayAgo, now),
    evaluateHealth(env, now),
  ]);

  // Membership joins in JS (bounded by the single windows fetch above).
  const openByMonitor = new Map(openIncidentRows.map((row) => [row.monitorId, row.id]));

  const counts = {
    totalActive: monitorRows.length,
    up: 0,
    down: 0,
    unknown: 0,
    paused: 0,
    inMaintenance: 0,
    openIncidents: openIncidentRows.length,
  };

  const tableRows: DashboardMonitorRow[] = monitorRows.map((row) => {
    const status = row.status ?? "unknown";
    switch (status) {
      case "up":
        counts.up += 1;
        break;
      case "down":
        counts.down += 1;
        break;
      case "paused":
        counts.paused += 1;
        break;
      default:
        counts.unknown += 1;
    }
    const inMaintenance = windows.some((window) => windowAppliesTo(window, row));
    if (inMaintenance) counts.inMaintenance += 1;

    const slice = uptimeByMonitor.get(row.id);
    const eligible = slice?.eligible ?? 0;
    const healthy = slice?.healthy ?? 0;
    const rounded = eligible === 0 ? null : Math.round((healthy / eligible) * 100 * 100) / 100;

    return {
      id: row.id,
      clientId: row.clientId,
      clientName: row.clientName ?? row.clientId,
      name: row.name,
      status,
      inMaintenance,
      uptime24h: {
        status: eligible === 0 ? "no_data" : "ok",
        percentage: rounded,
        eligibleChecks: eligible,
      },
      lastResponseTimeMs: row.lastResponseTimeMs,
      lastCheckedAt: row.lastCheckedAt,
      openIncidentId: openByMonitor.get(row.id) ?? null,
    };
  });

  // Trend points: hours where every rollup avg was NULL drop out (no signal).
  const trend = trendRows
    .map((row) => ({ hourStart: row.hourStart, avgResponseTimeMs: Math.round(Number(row.avgResponse ?? 0)) }))
    .filter((point) => Number.isFinite(point.avgResponseTimeMs) && point.avgResponseTimeMs > 0);

  return {
    counts,
    recentRecoveries: recoveryRows.map((row) => ({
      id: row.id,
      monitorId: row.monitorId,
      monitorName: row.monitorName,
      resolvedAt: row.resolvedAt ?? now,
      outageDurationMs: row.outageDurationMs,
    })),
    trend,
    heartbeat: { status: health.status, checks: health.checks },
    monitors: tableRows,
  };
}
