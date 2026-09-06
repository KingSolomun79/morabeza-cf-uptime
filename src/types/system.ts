/**
 * Mirrors of the worker DTOs behind the notifications + system pages
 * (issue #26; PRD §27.9, §27.10). Deliberate two-tsconfig duplication
 * (see src/types/dashboard.ts); the api-system test contract pins them.
 */

export type HeartbeatStatus = "fresh" | "stale" | "never_run";

export interface HeartbeatView {
  at: string | null;
  status: HeartbeatStatus;
}

export interface SystemReportDto {
  now: string;
  d1: { reachable: boolean };
  heartbeats: {
    scheduler: HeartbeatView;
    queueConsumer: HeartbeatView;
    hourlyRollup: HeartbeatView;
    dailyRollup: HeartbeatView;
    cleanup: HeartbeatView;
  };
  retention: { rawCheckDays: number; hourlyDays: number; dailyDays: number };
  deadLetters: { unresolved: number };
  version: string | null;
  emailConfigured: boolean;
}

export interface DeadLetterDto {
  id: string;
  originalJobId: string | null;
  messageType: string | null;
  payloadSummaryJson: string | null;
  failureReason: string | null;
  receivedAt: string;
  resolvedAt: string | null;
  resolutionNotes: string | null;
}

export interface NotificationEventDto {
  id: string;
  monitorId: string | null;
  incidentId: string | null;
  targetId: string;
  targetEmail: string;
  type: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}
