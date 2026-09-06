/**
 * Mirror of the worker's dashboard DTO (worker/services/dashboard.ts).
 * Duplicated deliberately: the two tsconfig projects (app vs worker) have
 * disjoint lib/type universes, so runtime types are restated here. The
 * api-dashboard test contract pins the shapes together.
 */

export interface DashboardMonitorRow {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
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
