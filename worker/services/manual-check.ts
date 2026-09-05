/**
 * Manual checks (issue #14; PRD §13, §24): "Run check now" for operators.
 *
 * POST /api/monitors/:id/check enqueues a diagnostic-only monitor.check job
 * (unique id, source=manual, affects_state=false) and returns immediately —
 * the check itself executes on the queue consumer (#9), persists like any
 * result, and is bypassed by the state machine / incidents / notifications
 * via the #12 gates (affects_state=0 → evaluator skips; maintenance flag is
 * #15's seam). Manual results are visible in history but never count toward
 * uptime (the #20 eligibility filter excludes source != scheduled).
 *
 * Throttle: a durable per-monitor anti-flood bound — the monitor.manual_check
 * audit row IS the invocation ledger, so at most one manual check per monitor
 * per window survives isolate restarts and spans isolates.
 */
import { and, eq, gt } from "drizzle-orm";
import { auditEvents } from "../../db/schema";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { getDb } from "../lib/db";
import { logEvent } from "../lib/logging";
import { getMonitorRow } from "../repositories/monitors";
import { recordAudit } from "../repositories/audit";
import { QueueProducer, queueBindingToQueueLike } from "../queue/producer";
import type { Env } from "../env";

/** V1 anti-flood bound (issue #14): one manual check per monitor per window. */
export const MANUAL_CHECK_WINDOW_MS = 10_000;

export interface ManualCheckReceipt {
  checkId: string;
  status: "queued";
}

export async function requestManualCheck(
  env: Env,
  monitorId: string,
  req: { actorEmail: string | null },
): Promise<ManualCheckReceipt> {
  const monitor = await getMonitorRow(env, monitorId);
  if (!monitor) throw ApiError.notFound("monitor not found");
  if (monitor.archivedAt) throw ApiError.conflict("monitor is archived — manual checks are rejected");
  if (monitor.enabled === 0) throw ApiError.conflict("monitor is disabled (paused) — re-enable it to run manual checks");

  const db = getDb(env);
  const cutoff = new Date(Date.now() - MANUAL_CHECK_WINDOW_MS).toISOString();
  const [recent] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "monitor.manual_check"),
        eq(auditEvents.entityId, monitorId),
        gt(auditEvents.createdAt, cutoff),
      ),
    )
    .limit(1);
  if (recent) {
    throw new ApiError(
      "rate_limited",
      `a manual check was already queued for this monitor within the last ${MANUAL_CHECK_WINDOW_MS / 1000}s`,
    );
  }

  // Unique id per invocation (PRD §13) — never reused, so the consumer's
  // idempotent claim executes every accepted manual check exactly once.
  const checkId = newId("chk");
  const producer = new QueueProducer(queueBindingToQueueLike(env.CHECK_QUEUE));
  await producer.send({
    type: "monitor.check",
    jobId: checkId,
    payload: {
      monitorId,
      checkId,
      scheduledFor: null,
      source: "manual",
      affectsState: false,
    },
  });

  await recordAudit(env, {
    actorEmail: req.actorEmail,
    action: "monitor.manual_check",
    entityType: "monitor",
    entityId: monitorId,
    summary: `manual check queued for ${monitor.name}`,
    metadata: { checkId },
  });

  logQueued(monitorId, checkId);
  return { checkId, status: "queued" };
}

function logQueued(monitorId: string, checkId: string): void {
  logEvent("api.manual_check_queued", { monitorId, checkId, outcome: "ok" });
}
