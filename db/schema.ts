/**
 * Morabeza CF Uptime — D1 (SQLite) schema, Drizzle ORM definitions.
 *
 * Source of truth for the data model: docs/PRD-SPEC.md §17. Column names are
 * snake_case in the database; TS properties are camelCase. All timestamps are
 * UTC ISO-8601 text; all entity ids are text (PRD §17 preamble).
 *
 * Conventions:
 * - Booleans are INTEGER 0/1 (SQLite) — interpret at the repository layer.
 * - Nothing is hard-deleted in normal flows: archive via archived_at (PRD §42.17).
 * - Migrations are generated with drizzle-kit into db/migrations and applied
 *   with `wrangler d1 migrations apply` (local dev + production, PRD §31).
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** §17.1 — group monitors by Morabeza/client. */
export const clients = sqliteTable(
  "clients",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    active: integer("active").notNull().default(1),
    notes: text("notes"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
  },
  (t) => [
    uniqueIndex("clients_slug_idx").on(t.slug),
    index("clients_active_idx").on(t.active),
  ],
);

/** §17.2 — a monitored HTTP endpoint. */
export const monitors = sqliteTable(
  "monitors",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: text("method").notNull().default("GET"),
    headersJson: text("headers_json"),
    requestBody: text("request_body"),
    expectedStatusCodesJson: text("expected_status_codes_json").notNull().default("[200]"),
    bodyContains: text("body_contains"),
    bodyNotContains: text("body_not_contains"),
    maxResponseTimeMs: integer("max_response_time_ms"),
    intervalSeconds: integer("interval_seconds").notNull().default(300),
    timeoutMs: integer("timeout_ms").notNull().default(10000),
    failureThreshold: integer("failure_threshold").notNull().default(3),
    recoveryThreshold: integer("recovery_threshold").notNull().default(2),
    cacheBust: integer("cache_bust").notNull().default(0),
    enabled: integer("enabled").notNull().default(1),
    nextCheckAt: text("next_check_at").notNull(),
    tagsJson: text("tags_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
  },
  (t) => [
    index("monitors_client_id_idx").on(t.clientId),
    index("monitors_enabled_next_check_idx").on(t.enabled, t.nextCheckAt),
    index("monitors_archived_idx").on(t.archivedAt),
  ],
);

/** §17.5 — one incident per DOWN..UP outage. At most one open per monitor:
 * partial unique index added in migration 0001 (see db/migrations). */
export const incidents = sqliteTable(
  "incidents",
  {
    id: text("id").primaryKey(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id),
    status: text("status").notNull(), // open | resolved | closed_admin
    openedAt: text("opened_at").notNull(),
    firstFailureAt: text("first_failure_at").notNull(),
    resolvedAt: text("resolved_at"),
    triggerCheckId: text("trigger_check_id"),
    recoveryCheckId: text("recovery_check_id"),
    openReasonCode: text("open_reason_code"),
    outageDurationMs: integer("outage_duration_ms"),
    resolutionReason: text("resolution_reason"), // recovered | monitor_disabled | admin
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("incidents_monitor_status_idx").on(t.monitorId, t.status)],
);

/** §17.3 — one row per monitor: canonical state + out-of-order guard fields. */
export const monitorState = sqliteTable("monitor_state", {
  monitorId: text("monitor_id")
    .primaryKey()
    .references(() => monitors.id),
  status: text("status").notNull().default("unknown"), // unknown | up | down | paused
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
  failureSequenceStartedAt: text("failure_sequence_started_at"),
  lastEvaluatedScheduledFor: text("last_evaluated_scheduled_for"),
  lastCheckedAt: text("last_checked_at"),
  lastSuccessAt: text("last_success_at"),
  lastFailureAt: text("last_failure_at"),
  lastStatusCode: integer("last_status_code"),
  lastResponseTimeMs: integer("last_response_time_ms"),
  lastReasonCode: text("last_reason_code"),
  openIncidentId: text("open_incident_id").references(() => incidents.id),
  stateVersion: integer("state_version").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

/** §17.4 — every check result (scheduled + manual). id is the check id. */
export const checkResults = sqliteTable(
  "check_results",
  {
    id: text("id").primaryKey(), // checkId — deterministic for scheduled checks (PRD §15.4)
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id),
    source: text("source").notNull(), // scheduled | manual
    scheduledFor: text("scheduled_for"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at").notNull(),
    isHealthy: integer("is_healthy").notNull(),
    maintenanceExcluded: integer("maintenance_excluded").notNull().default(0),
    affectsState: integer("affects_state").notNull().default(0),
    statusCode: integer("status_code"),
    responseTimeMs: integer("response_time_ms"),
    finalUrl: text("final_url"),
    reasonCode: text("reason_code").notNull(),
    errorMessage: text("error_message"),
    assertionsJson: text("assertions_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("check_results_monitor_completed_idx").on(t.monitorId, sql`${t.completedAt} desc`),
    index("check_results_completed_idx").on(t.completedAt),
    index("check_results_source_completed_idx").on(t.source, t.completedAt),
  ],
);

/** §17.6 — planned maintenance; an overlay, never a monitor status (PRD §12.1). */
export const maintenanceWindows = sqliteTable(
  "maintenance_windows",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    scopeType: text("scope_type").notNull(), // global | client | monitor
    scopeId: text("scope_id"),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    cancelledAt: text("cancelled_at"),
  },
  (t) => [index("maintenance_windows_scope_idx").on(t.scopeType, t.scopeId)],
);

/** §17.7 — verified operational alert recipients. */
export const notificationTargets = sqliteTable("notification_targets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  enabled: integer("enabled").notNull().default(1),
  isDefault: integer("is_default").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [uniqueIndex("notification_targets_email_idx").on(t.email)]);

/** §17.8 — per-monitor explicit recipient mapping; fallback = is_default targets. */
export const monitorNotificationTargets = sqliteTable(
  "monitor_notification_targets",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id),
    targetId: text("target_id")
      .notNull()
      .references(() => notificationTargets.id),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.targetId] })],
);

/** §17.9 — notification intents with mandatory dedupe keys (PRD §9.3/§9.6). */
export const notificationEvents = sqliteTable(
  "notification_events",
  {
    id: text("id").primaryKey(),
    dedupeKey: text("dedupe_key").notNull(),
    // Nullable: `test` events (PRD §24) are sent to a target with no
    // monitor context — only transition events carry a monitor.
    monitorId: text("monitor_id").references(() => monitors.id),
    incidentId: text("incident_id").references(() => incidents.id),
    targetId: text("target_id")
      .notNull()
      .references(() => notificationTargets.id),
    type: text("type").notNull(), // down | recovered | test
    status: text("status").notNull(), // pending | sending | sent | failed
    attempts: integer("attempts").notNull().default(0),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    sentAt: text("sent_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("notification_events_dedupe_key_idx").on(t.dedupeKey)],
);

/** §17.10 — hourly uptime/response aggregates (raw-history replacement). */
export const hourlyRollups = sqliteTable(
  "hourly_rollups",
  {
    monitorId: text("monitor_id").notNull(),
    hourStart: text("hour_start").notNull(),
    eligibleChecks: integer("eligible_checks").notNull(),
    upChecks: integer("up_checks").notNull(),
    downChecks: integer("down_checks").notNull(),
    avgResponseTimeMs: real("avg_response_time_ms"),
    minResponseTimeMs: integer("min_response_time_ms"),
    maxResponseTimeMs: integer("max_response_time_ms"),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.hourStart] })],
);

/** §17.11 — daily uptime/response aggregates incl. incident count + downtime. */
export const dailyRollups = sqliteTable(
  "daily_rollups",
  {
    monitorId: text("monitor_id").notNull(),
    dayStart: text("day_start").notNull(),
    eligibleChecks: integer("eligible_checks").notNull(),
    upChecks: integer("up_checks").notNull(),
    downChecks: integer("down_checks").notNull(),
    avgResponseTimeMs: real("avg_response_time_ms"),
    minResponseTimeMs: integer("min_response_time_ms"),
    maxResponseTimeMs: integer("max_response_time_ms"),
    incidentCount: integer("incident_count").notNull().default(0),
    downtimeMs: integer("downtime_ms").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.monitorId, t.dayStart] })],
);

/** §17.12 — one row per cron run; short retention (PRD §18). */
export const schedulerRuns = sqliteTable("scheduler_runs", {
  id: text("id").primaryKey(),
  scheduledAt: text("scheduled_at").notNull(),
  dueMonitorCount: integer("due_monitor_count").notNull(),
  enqueuedCount: integer("enqueued_count").notNull(),
  failedBatchCount: integer("failed_batch_count").notNull().default(0),
  durationMs: integer("duration_ms").notNull(),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
});

/** §17.13 — single-row system heartbeat/config projection (id = 'system'). */
export const systemState = sqliteTable("system_state", {
  id: text("id").primaryKey(), // always 'system'
  lastSchedulerAt: text("last_scheduler_at"),
  lastQueueConsumerAt: text("last_queue_consumer_at"),
  lastHourlyRollupAt: text("last_hourly_rollup_at"),
  lastDailyRollupAt: text("last_daily_rollup_at"),
  lastCleanupAt: text("last_cleanup_at"),
  updatedAt: text("updated_at").notNull(),
});

/** §17.14 — admin mutation audit trail (PRD §8.4, §29). */
export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  actorEmail: text("actor_email"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  summary: text("summary"),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at").notNull(),
});

/** §17.15 — DLQ visibility persisted by the DLQ consumer (PRD §16.6). */
export const deadLetterEvents = sqliteTable("dead_letter_events", {
  id: text("id").primaryKey(),
  originalJobId: text("original_job_id"),
  messageType: text("message_type"),
  payloadSummaryJson: text("payload_summary_json"),
  failureReason: text("failure_reason"),
  receivedAt: text("received_at").notNull(),
  resolvedAt: text("resolved_at"),
  resolutionNotes: text("resolution_notes"),
});
