/**
 * monitor.check job handler (issue #9; PRD §16.4, §20).
 *
 * Consumer sequence (PRD §16.4):
 *  1. the envelope+payload were validated by the consumer router;
 *  2. execute the HTTP check with config loaded FRESH from D1 (§20.1 — the
 *     queue payload carries ids only, never configuration);
 *  3. insert the result keyed by the deterministic checkId;
 *  4. duplicate insert → the job was already completed: skip ALL state side
 *     effects (at-least-once delivery, §16.3);
 *  5–7. state evaluation, incident lifecycle, and notification intents belong
 *     to the CLAIMER only — #12/#13/#17 hook at the marked seam below.
 *
 * Rejections per §20.2–§20.3: archived monitors are never checked; disabled
 * monitors no-op for scheduled work (operator-requested manual diagnostics
 * still run — they never affect state).
 */
import { eq } from "drizzle-orm";
import { checkResults, monitors, type monitors as monitorsTable } from "../../../db/schema";
import { runCheck, type MonitorCheckConfig } from "../../services/checker";
import { evaluateCheckAgainstState, type TransitionListener } from "../../services/state-evaluation";
import { findActiveMaintenanceWindow } from "../../repositories/maintenance";
import { getDb } from "../../lib/db";
import { nowIso } from "../../lib/time";
import { logEvent } from "../../lib/logging";
import { claimUniqueRow } from "../idempotency";
import type { JobContext, JobHandler } from "../consumer";

export interface MonitorCheckDeps {
  fetchImpl?: typeof fetch;
  /**
   * Transition subscriber for #12's seam (#13 incidents, #17 notifications
   * register real listeners; default logs the structured event).
   */
  onTransition?: TransitionListener;
}

type MonitorRow = typeof monitorsTable.$inferSelect;

function parseJsonSafe<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Maps a D1 monitor row to the checker's config shape (PRD §20.4–§20.9). */
export function toCheckConfig(monitor: MonitorRow): MonitorCheckConfig {
  return {
    url: monitor.url,
    method: monitor.method as MonitorCheckConfig["method"],
    headers: parseJsonSafe<Record<string, string> | null>(monitor.headersJson, null) ?? undefined,
    requestBody: monitor.requestBody,
    expectedStatusCodes: parseJsonSafe<number[]>(monitor.expectedStatusCodesJson, [200]),
    bodyContains: monitor.bodyContains,
    bodyNotContains: monitor.bodyNotContains,
    maxResponseTimeMs: monitor.maxResponseTimeMs,
    timeoutMs: monitor.timeoutMs,
    cacheBust: monitor.cacheBust === 1,
  };
}

export function createMonitorCheckHandler(deps: MonitorCheckDeps = {}): JobHandler<"monitor.check"> {
  return async (payload, ctx: JobContext) => {
    const db = getDb(ctx.env);
    const startedAt = nowIso();

    const [monitor] = await db.select().from(monitors).where(eq(monitors.id, payload.monitorId));
    if (!monitor) {
      logEvent("queue.check_skipped", {
        jobId: ctx.jobId,
        checkId: payload.checkId,
        monitorId: payload.monitorId,
        outcome: "monitor_missing",
      });
      return;
    }
    if (monitor.archivedAt) {
      logEvent("queue.check_skipped", {
        jobId: ctx.jobId,
        checkId: payload.checkId,
        monitorId: monitor.id,
        outcome: "monitor_archived",
      });
      return;
    }
    if (payload.source === "scheduled" && monitor.enabled === 0) {
      logEvent("queue.check_skipped", {
        jobId: ctx.jobId,
        checkId: payload.checkId,
        monitorId: monitor.id,
        outcome: "monitor_disabled",
      });
      return;
    }

    const activeWindow = await findActiveMaintenanceWindow(
      db,
      { monitorId: monitor.id, clientId: monitor.clientId },
      startedAt,
    );
    if (activeWindow) {
      // PRD §14.1: checks continue to run, the result is flagged as
      // maintenance-excluded, and the evaluator below bypasses state,
      // counters, incidents, and notifications.
      logEvent("queue.check_maintenance", {
        jobId: ctx.jobId,
        monitorId: monitor.id,
        checkId: payload.checkId,
        windowId: activeWindow.id,
        windowScope: activeWindow.scopeType,
        outcome: "excluded",
      });
    }

    const outcome = await runCheck(toCheckConfig(monitor), {
      fetchImpl: deps.fetchImpl ?? fetch,
      checkId: payload.checkId,
      checkSlot: payload.scheduledFor ?? payload.checkId,
    });
    const completedAt = nowIso();

    // Only scheduled checks participate in the state machine (PRD §12.6);
    // manual results are diagnostic-only (PRD §13).
    const affectsState = payload.source === "scheduled" && payload.affectsState ? 1 : 0;
    const assertionsJson =
      outcome.assertions || outcome.excerpt
        ? JSON.stringify({
            ...(outcome.assertions ?? {}),
            ...(outcome.excerpt ? { excerpt: outcome.excerpt } : {}),
          })
        : null;

    const claimed = await claimUniqueRow(ctx.env, checkResults, {
      id: payload.checkId,
      monitorId: monitor.id,
      source: payload.source,
      scheduledFor: payload.scheduledFor,
      startedAt,
      completedAt,
      isHealthy: outcome.isHealthy ? 1 : 0,
      // Flagged by live-window resolution above (#15, PRD §14).
      maintenanceExcluded: activeWindow ? 1 : 0,
      affectsState,
      statusCode: outcome.statusCode,
      responseTimeMs: outcome.responseTimeMs,
      finalUrl: outcome.finalUrl,
      reasonCode: outcome.reasonCode,
      errorMessage: outcome.errorMessage,
      assertionsJson,
      createdAt: completedAt,
    });

    if (!claimed) {
      // PRD §16.4 step 4: result already exists — never repeat side effects.
      logEvent("queue.check_completed", {
        jobId: ctx.jobId,
        monitorId: monitor.id,
        checkId: payload.checkId,
        reasonCode: outcome.reasonCode,
        outcome: "duplicate_skipped",
      });
      return;
    }

    // ── #12: state evaluation, incidents, notifications ──────────────────
    // ONLY the claimer reaches this point (PRD §16.4 step 5). Evaluation is
    // gated inside on affects_state/maintenance_excluded/paused; the pure
    // core decides the transition and the CAS update applies it in order.
    // #13 opens/resolves incidents and #17 enqueues notification intents via
    // the transition listener — all anchored on this check result.
    await evaluateCheckAgainstState(
      { db, onTransition: deps.onTransition },
      {
        monitorId: monitor.id,
        failureThreshold: monitor.failureThreshold,
        recoveryThreshold: monitor.recoveryThreshold,
      },
      {
        checkId: payload.checkId,
        source: payload.source,
        scheduledFor: payload.scheduledFor,
        isHealthy: outcome.isHealthy,
        maintenanceExcluded: activeWindow !== null,
        affectsState: affectsState === 1,
        statusCode: outcome.statusCode,
        responseTimeMs: outcome.responseTimeMs,
        reasonCode: outcome.reasonCode,
        completedAt,
      },
    ).then((evaluation) => {
      // Operator visibility on WHY state didn't move (PRD §16.5 debugging).
      if (!evaluation.applied) {
        logEvent("state.evaluation_skipped", {
          jobId: ctx.jobId,
          monitorId: monitor.id,
          checkId: payload.checkId,
          source: payload.source,
          reason: evaluation.reason,
        });
      }
    });
    // ─────────────────────────────────────────────────────────────────────

    logEvent("queue.check_completed", {
      jobId: ctx.jobId,
      monitorId: monitor.id,
      checkId: payload.checkId,
      reasonCode: outcome.reasonCode,
      durationMs: outcome.responseTimeMs,
      outcome: "ok",
    });
  };
}
