/**
 * Email notification intents + templates (issue #17; PRD §9, §16.4 steps
 * 6–7, §17.8, §37.3/§37.5).
 *
 * Transition → intent (subscribed on the #12/#13 seam, AFTER incident
 * persistence in the default pipeline): on `down`/`recovered` crossings
 * resolve the incident, resolve recipients, create ONE `notification_events`
 * row per target (`status=pending`, dedupe key `{incident_id}:{type}:{target_id}`
 * — the UNIQUE index makes duplicate intent creation inert, §37.3), then
 * enqueue one `notification.send` job per row with `jobId = notificationEventId`
 * (deterministic → duplicate enqueues/deliveries are inert at the handler).
 * Sends happen ONLY via the queue (§42.14) and never inside the check
 * transaction (§9.6): an email failure cannot roll back a state transition
 * (§37.5).
 *
 * `up` (unknown→up) intentionally produces nothing (PRD §9.3, §12.5).
 */
import { and, eq, inArray } from "drizzle-orm";
import { checkResults, clients, incidents, monitorState, monitors, notificationEvents } from "../../db/schema";
import { getDb } from "../lib/db";
import type { Env } from "../env";
import { logEvent } from "../lib/logging";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";
import { getTarget, resolveTargets } from "../repositories/notifications";
import { QueueProducer, queueBindingToQueueLike } from "../queue/producer";
import type { StateTransitionEvent } from "./state-evaluation";

/** Intent type stored on notification_events (PRD §17.9: down|recovered|test). */
export type NotificationType = "down" | "recovered" | "test";

/** Structural port of the EMAIL binding — tests inject fakes (issue #17). */
export type SendEmailPort = (message: {
  from: string;
  to: string;
  subject: string;
  text: string;
}) => Promise<{ messageId: string }>;

/** PRD §9.1 recommended default; overridable via DEFAULT_FROM_EMAIL. */
export const DEFAULT_FROM_EMAIL = "Morabeza Uptime <uptime@morabeza.digital>";

/**
 * Seam subscriber: create pending events + enqueue sends for a transition.
 * Runs after handleIncidentLifecycle so the incident anchor already exists.
 */
export async function handleNotificationIntents(env: Env, event: StateTransitionEvent): Promise<void> {
  const type: NotificationType | null =
    event.transition.type === "down" ? "down" : event.transition.type === "recovered" ? "recovered" : null;
  if (type === null) return; // `up` (unknown→up): never notifies (PRD §9.3)

  const incident = await findIncidentForIntent(env, event, type);
  if (!incident) {
    logEvent("notification.intents_skipped", {
      incidentId: null,
      monitorId: event.monitorId,
      checkId: event.checkId,
      type,
      outcome: "no_incident_anchor",
    });
    return;
  }

  const targets = await resolveTargets(env, event.monitorId);
  if (targets.length === 0) {
    logEvent("notification.intents_skipped", {
      incidentId: incident.id,
      monitorId: event.monitorId,
      checkId: event.checkId,
      type,
      outcome: "no_targets",
    });
    return;
  }

  const db = getDb(env);
  const at = event.at;
  const eventIds: string[] = [];
  for (const target of targets) {
    // The insert IS the claim (§37.3): the dedupe_key UNIQUE index turns a
    // duplicate intent creation into a no-op — and only claimed rows are
    // enqueued, so duplicate deliveries never double-enqueue.
    const claimed = await db
      .insert(notificationEvents)
      .values({
        id: newId("ntf"),
        dedupeKey: `${incident.id}:${type}:${target.id}`,
        monitorId: event.monitorId,
        incidentId: incident.id,
        targetId: target.id,
        type,
        status: "pending",
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing()
      .returning({ id: notificationEvents.id });
    if (claimed.length > 0) eventIds.push(claimed[0].id);
  }

  // §9.6 step 3: enqueue only AFTER the rows are persisted. One job per row,
  // jobId = the row id (deterministic — handler dedupes on status anyway).
  // The seam never re-fires for this checkId, so if the enqueue itself fails
  // the just-created rows would sit `pending` forever with no job — fail
  // them visibly instead (operator history keeps the gap, §28 log keeps the
  // signal). A stale-`pending` reconciler is a candidate for #18/#19.
  if (eventIds.length > 0) {
    const producer = new QueueProducer(queueBindingToQueueLike(env.CHECK_QUEUE));
    try {
      await producer.sendBatch(
        eventIds.map((notificationEventId) => ({
          type: "notification.send" as const,
          jobId: notificationEventId,
          payload: { notificationEventId },
        })),
      );
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      await db
        .update(notificationEvents)
        .set({ status: "failed", lastError: `enqueue failed: ${lastError}`, updatedAt: at })
        .where(inArray(notificationEvents.id, eventIds));
      throw error;
    }
  }

  logEvent("notification.intents_created", {
    incidentId: incident.id,
    monitorId: event.monitorId,
    checkId: event.checkId,
    type,
    count: eventIds.length,
    outcome: "ok",
  });
}

/**
 * The incident anchor for an intent. DOWN: the incident this check claimed
 * (falling back to the currently-open incident keeps a duplicate DOWN inert —
 * its dedupe keys already exist, so nothing re-alerts). RECOVERED: the
 * incident THIS transition resolved (recovery_check_id = this check).
 */
async function findIncidentForIntent(
  env: Env,
  event: StateTransitionEvent,
  type: "down" | "recovered",
) {
  const db = getDb(env);
  if (type === "down") {
    const [byTrigger] = await db
      .select()
      .from(incidents)
      .where(and(eq(incidents.monitorId, event.monitorId), eq(incidents.triggerCheckId, event.checkId)));
    if (byTrigger) return byTrigger;
    const [state] = await db
      .select({ openIncidentId: monitorState.openIncidentId })
      .from(monitorState)
      .where(eq(monitorState.monitorId, event.monitorId));
    if (!state?.openIncidentId) return null;
    const [open] = await db.select().from(incidents).where(eq(incidents.id, state.openIncidentId));
    return open ?? null;
  }
  const [recovered] = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.monitorId, event.monitorId), eq(incidents.recoveryCheckId, event.checkId)));
  return recovered ?? null;
}

/**
 * Test email (PRD §24, §27.9): one `test` event with a unique-per-invocation
 * dedupe key, no monitor, no incident — sent through the same queue pipeline
 * as alerts. Returns the queued event id (202 semantics at the route).
 */
export async function queueTestEmail(
  env: Env,
  targetId: string,
): Promise<{ notificationEventId: string; targetEmail: string }> {
  const target = await getTarget(env, targetId); // 404 surface for unknown ids
  const id = newId("ntf");
  const now = nowIso();
  const db = getDb(env);
  await db.insert(notificationEvents).values({
    id,
    // Unique per invocation: a test is an explicit operator action and must
    // always send (unlike transition alerts, which dedupe per incident).
    dedupeKey: `${targetId}:test:${crypto.randomUUID()}`,
    monitorId: null,
    incidentId: null,
    targetId,
    type: "test",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  const producer = new QueueProducer(queueBindingToQueueLike(env.CHECK_QUEUE));
  try {
    await producer.send({
      type: "notification.send",
      jobId: id,
      payload: { notificationEventId: id },
    });
  } catch (error) {
    const lastError = error instanceof Error ? error.message : String(error);
    await db
      .update(notificationEvents)
      .set({ status: "failed", lastError: `enqueue failed: ${lastError}`, updatedAt: now })
      .where(eq(notificationEvents.id, id));
    throw error;
  }
  logEvent("notification.test_queued", { notificationEventId: id, targetId, outcome: "ok" });
  return { notificationEventId: id, targetEmail: target.email };
}

// ── Templates (PRD §9.4 / §9.5 / §24 test) ─────────────────────────────────

export interface DownEmailInput {
  clientName: string;
  monitorName: string;
  url: string;
  reasonCode: string;
  statusCode: number | null;
  responseTimeMs: number | null;
  consecutiveFailures: number;
  openedAt: string;
  detailUrl: string;
}

export function renderDownEmail(input: DownEmailInput): { subject: string; text: string } {
  const subject = `[DOWN] ${input.clientName} — ${input.monitorName}`;
  const lines = [
    `Client: ${input.clientName}`,
    `Monitor: ${input.monitorName}`,
    `URL: ${input.url}`,
    `Failure reason: ${input.reasonCode}`,
    ...(input.statusCode !== null ? [`HTTP status: ${input.statusCode}`] : []),
    ...(input.responseTimeMs !== null ? [`Response time: ${input.responseTimeMs} ms`] : []),
    `Consecutive failures: ${input.consecutiveFailures}`,
    `Incident opened at: ${input.openedAt}`,
    `Detail: ${input.detailUrl}`,
  ];
  return { subject, text: lines.join("\n") };
}

export interface RecoveredEmailInput {
  clientName: string;
  monitorName: string;
  recoveredAt: string;
  outageDurationMs: number | null;
  responseTimeMs: number | null;
  incidentUrl: string;
}

export function renderRecoveredEmail(input: RecoveredEmailInput): { subject: string; text: string } {
  const subject = `[RECOVERED] ${input.clientName} — ${input.monitorName}`;
  const lines = [
    `Client: ${input.clientName}`,
    `Monitor: ${input.monitorName}`,
    `Recovered at: ${input.recoveredAt}`,
    ...(input.outageDurationMs !== null ? [`Outage duration: ${humanizeDuration(input.outageDurationMs)}`] : []),
    ...(input.responseTimeMs !== null ? [`Response time: ${input.responseTimeMs} ms`] : []),
    `Incident: ${input.incidentUrl}`,
  ];
  return { subject, text: lines.join("\n") };
}

export function renderTestEmail(targetName: string, appOrigin: string): { subject: string; text: string } {
  return {
    subject: `[TEST] Morabeza Uptime — notification check for ${targetName}`,
    text: [
      "This is a test notification from Morabeza Uptime.",
      "If you received this email, alert delivery to this target is wired up correctly.",
      `Dashboard: ${appOrigin}`,
    ].join("\n"),
  };
}

function humanizeDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s (${ms} ms)`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Loads the check-result slice (status/response time) for an email body. */
export async function loadCheckResultSlice(
  env: Env,
  checkId: string | null,
): Promise<{ statusCode: number | null; responseTimeMs: number | null } | null> {
  if (!checkId) return null;
  const [row] = await getDb(env)
    .select({ statusCode: checkResults.statusCode, responseTimeMs: checkResults.responseTimeMs })
    .from(checkResults)
    .where(eq(checkResults.id, checkId));
  return row ?? null;
}

/** Monitor + client names for subject lines (single join). */
export async function loadMonitorLabel(
  env: Env,
  monitorId: string,
): Promise<{ monitorName: string; clientName: string; url: string } | null> {
  const [row] = await getDb(env)
    .select({ monitorName: monitors.name, clientName: clients.name, url: monitors.url })
    .from(monitors)
    .innerJoin(clients, eq(clients.id, monitors.clientId))
    .where(eq(monitors.id, monitorId));
  return row ?? null;
}
