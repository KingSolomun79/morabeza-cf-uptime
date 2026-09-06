/**
 * notification.send job handler (issue #17; PRD §9.6, §17.9, §37.3).
 *
 * One job per notification_events row (jobId = the row id):
 *  1. load the event — missing row or non-`pending` status → ack, no-op
 *     (at-least-once redelivery can never double-send, §37.3);
 *  2. claim `sending` conditionally (`WHERE status='pending'`) so interleaved
 *     deliveries serialize on the row;
 *  3. render §9.4/§9.5/§24 templates and send through the EMAIL binding
 *     (or the injected sender in tests);
 *  4. success → `sent` + provider_message_id + sent_at;
 *  5. failure → attempts += 1, last_error recorded, row back to `pending`,
 *     then THROW so the Queue retry model drives redelivery (§9.6) — after
 *     max_retries the message lands in the DLQ with the error preserved on
 *     the row. The state transition is never rolled back (§37.5).
 *
 * The retryable try spans lookup + rendering + sending: any throw after the
 * `sending` claim returns the row to `pending` (a redelivery would otherwise
 * skip on non-pending and strand the alert). Known residual: a Worker killed
 * AFTER the claim with no throw (isolate eviction) leaves `sending` stuck —
 * redeliveries ack rather than risk a §37.3 double-send; a stale-`sending`
 * reconciler is a candidate for #18/#19 housekeeping.
 *
 * Logs carry ids and outcomes only — never body content or secrets (§28).
 */
import { and, eq } from "drizzle-orm";
import { incidents, monitorState, notificationEvents, notificationTargets } from "../../../db/schema";
import { getDb } from "../../lib/db";
import type { Env } from "../../env";
import { logEvent } from "../../lib/logging";
import { nowIso } from "../../lib/time";
import {
  DEFAULT_FROM_EMAIL,
  loadCheckResultSlice,
  loadMonitorLabel,
  renderDownEmail,
  renderRecoveredEmail,
  renderTestEmail,
  type SendEmailPort,
} from "../../services/notifications";
import type { JobContext, JobHandler } from "../consumer";

export interface NotificationSendDeps {
  /** Injectable sender (tests fake it); defaults to the env.EMAIL binding. */
  sendEmail?: SendEmailPort;
}

export function resolveSender(env: Env, deps: NotificationSendDeps): SendEmailPort {
  if (deps.sendEmail) return deps.sendEmail;
  return async (message) => {
    if (!env.EMAIL) {
      // Fail loudly: the row returns to `pending` with this error recorded,
      // retries exhaust, and the DLQ keeps the event visible (issue #8).
      throw new Error("EMAIL binding is not configured (PRD §9.2; provisioned in issue #29)");
    }
    return env.EMAIL.send(message);
  };
}

export function createNotificationSendHandler(deps: NotificationSendDeps = {}): JobHandler<"notification.send"> {
  return async (payload, ctx: JobContext) => {
    const env = ctx.env;
    const db = getDb(env);

    const [event] = await db
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.id, payload.notificationEventId));
    if (!event) {
      logEvent("notification.send_skipped", {
        notificationEventId: payload.notificationEventId,
        jobId: ctx.jobId,
        reason: "event_missing",
        outcome: "skipped",
      });
      return;
    }
    if (event.status !== "pending") {
      // Sent / sending / failed-terminal — a redelivery has nothing to do.
      logEvent("notification.send_skipped", {
        notificationEventId: event.id,
        jobId: ctx.jobId,
        reason: `status_${event.status}`,
        outcome: "skipped",
      });
      return;
    }

    // Claim before rendering/sending: interleaved deliveries serialize here.
    const claimed = await db
      .update(notificationEvents)
      .set({ status: "sending", updatedAt: nowIso() })
      .where(and(eq(notificationEvents.id, event.id), eq(notificationEvents.status, "pending")))
      .returning({ id: notificationEvents.id });
    if (claimed.length === 0) {
      logEvent("notification.send_skipped", {
        notificationEventId: event.id,
        jobId: ctx.jobId,
        reason: "claimed_elsewhere",
        outcome: "skipped",
      });
      return;
    }

    // Everything after the claim is transient-retryable: a throw ANYWHERE in
    // this block (target lookup, rendering, sending — e.g. a D1 hiccup) must
    // return the row to `pending`, or the redelivery would skip on
    // `status !== "pending"` and the alert would be silently lost. Only the
    // deliberate terminal `return` for a missing target escapes the catch.
    try {
      const [target] = await db
        .select({ email: notificationTargets.email, name: notificationTargets.name })
        .from(notificationTargets)
        .where(eq(notificationTargets.id, event.targetId));
      if (!target) {
        // Permanent condition (history blocks target deletion, so this is
        // pathological): fail the row terminally instead of retrying forever.
        await db
          .update(notificationEvents)
          .set({ status: "failed", lastError: "notification target missing", updatedAt: nowIso() })
          .where(eq(notificationEvents.id, event.id));
        logEvent("notification.send_skipped", {
          notificationEventId: event.id,
          jobId: ctx.jobId,
          reason: "target_missing",
          outcome: "failed",
        });
        return;
      }

      const message = await renderMessage(
        env,
        event.id,
        // Column values are constrained to the §17.9 type set by construction.
        event.type as "down" | "recovered" | "test",
        event.monitorId,
        event.incidentId,
        target.name,
      );
      const from = env.DEFAULT_FROM_EMAIL ?? DEFAULT_FROM_EMAIL;

      const result = await resolveSender(env, deps)({ from, to: target.email, ...message });
      await db
        .update(notificationEvents)
        .set({ status: "sent", providerMessageId: result.messageId, sentAt: nowIso(), updatedAt: nowIso() })
        .where(eq(notificationEvents.id, event.id));
      logEvent("notification.sent", {
        notificationEventId: event.id,
        jobId: ctx.jobId,
        targetId: event.targetId,
        type: event.type,
        outcome: "ok",
      });
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      await db
        .update(notificationEvents)
        .set({
          status: "pending", // Queue redelivery re-claims and re-sends (§9.6)
          attempts: event.attempts + 1,
          lastError,
          updatedAt: nowIso(),
        })
        .where(eq(notificationEvents.id, event.id));
      logEvent("notification.retry_scheduled", {
        notificationEventId: event.id,
        jobId: ctx.jobId,
        targetId: event.targetId,
        type: event.type,
        attempts: event.attempts + 1,
        outcome: "retry_scheduled",
        error: lastError,
      });
      throw error; // consumer schedules the retry; DLQ after max_retries
    }
  };
}

/** Builds the subject/body for an event's type (§9.4/§9.5/§24). */
async function renderMessage(
  env: Env,
  eventId: string,
  type: "down" | "recovered" | "test",
  monitorId: string | null,
  incidentId: string | null,
  targetName: string,
): Promise<{ subject: string; text: string }> {
  if (type === "test") {
    return renderTestEmail(targetName, env.APP_ORIGIN);
  }
  if (!monitorId) {
    // Transition events always carry a monitor; defensive fallback keeps the
    // handler total if data is inconsistent.
    return { subject: `[${type.toUpperCase()}] Morabeza Uptime`, text: `Notification ${eventId} is missing monitor context.` };
  }

  const label = (await loadMonitorLabel(env, monitorId)) ?? {
    monitorName: monitorId,
    clientName: "Unknown client",
    url: "",
  };
  const incident = incidentId ? await loadIncident(env, incidentId) : null;

  if (type === "down") {
    const [state] = await getDb(env)
      .select({ consecutiveFailures: monitorState.consecutiveFailures })
      .from(monitorState)
      .where(eq(monitorState.monitorId, monitorId));
    const trigger = await loadCheckResultSlice(env, incident?.triggerCheckId ?? null);
    return renderDownEmail({
      clientName: label.clientName,
      monitorName: label.monitorName,
      url: label.url,
      reasonCode: incident?.openReasonCode ?? "unknown",
      statusCode: trigger?.statusCode ?? null,
      responseTimeMs: trigger?.responseTimeMs ?? null,
      consecutiveFailures: state?.consecutiveFailures ?? 0,
      openedAt: incident?.openedAt ?? nowIso(),
      detailUrl: `${env.APP_ORIGIN}/monitors/${monitorId}`,
    });
  }

  // recovered
  const recovery = await loadCheckResultSlice(env, incident?.recoveryCheckId ?? null);
  return renderRecoveredEmail({
    clientName: label.clientName,
    monitorName: label.monitorName,
    recoveredAt: incident?.resolvedAt ?? nowIso(),
    outageDurationMs: incident?.outageDurationMs ?? null,
    responseTimeMs: recovery?.responseTimeMs ?? null,
    incidentUrl: `${env.APP_ORIGIN}/incidents/${incidentId ?? monitorId}`,
  });
}

async function loadIncident(env: Env, incidentId: string) {
  const [row] = await getDb(env).select().from(incidents).where(eq(incidents.id, incidentId));
  return row ?? null;
}
