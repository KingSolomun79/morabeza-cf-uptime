/**
 * Mirrors of the worker DTOs behind the monitor detail page (issue #24;
 * PRD §27.5) — checks (#24 extension), incidents (#13), maintenance
 * windows (#15), notification targets (#16), and uptime (#20). Duplicated
 * deliberately per the two-tsconfig convention (see src/types/dashboard.ts);
 * the api-monitor-detail / api-incidents / api-maintenance test contracts
 * pin the shapes together.
 */

export interface CheckDto {
  id: string;
  monitorId: string;
  source: "scheduled" | "manual";
  completedAt: string;
  isHealthy: boolean;
  maintenanceExcluded: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  reasonCode: string;
  errorMessage: string | null;
}

export interface MonitorIncidentDto {
  id: string;
  monitorId: string;
  status: "open" | "resolved" | "closed_admin";
  openedAt: string;
  firstFailureAt: string;
  resolvedAt: string | null;
  triggerCheckId: string | null;
  recoveryCheckId: string | null;
  openReasonCode: string | null;
  outageDurationMs: number | null;
  resolutionReason: "recovered" | "monitor_disabled" | "admin" | null;
  createdAt: string;
  updatedAt: string;
}

export type MaintenanceScopeType = "global" | "client" | "monitor";

export interface MaintenanceWindowDto {
  id: string;
  title: string;
  description: string | null;
  scopeType: MaintenanceScopeType;
  scopeId: string | null;
  startsAt: string;
  endsAt: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

export interface NotificationTargetDto {
  id: string;
  name: string;
  email: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/monitors/:id/uptime?window=… (issue #20). */
export interface UptimeDto {
  monitorId: string;
  window: "24h" | "7d" | "30d" | "90d";
  status: "ok" | "no_data";
  percentage: number | null;
  eligibleChecks: number;
  healthyChecks: number;
  source: "raw" | "rollup" | "blended";
}
