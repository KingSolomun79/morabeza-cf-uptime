/**
 * Public /healthz degradation checks (issue #11; PRD §19).
 *
 * The watchdog contract: the monitoring control plane reports honestly
 * whether ITSELF is alive — D1 reachable, the cron scheduler and the queue
 * consumer running with fresh heartbeats. Deliberately minimal: no monitor
 * names, ids, versions, or timestamps in the externally visible response.
 *
 * Freshness (PRD §19 "after bootstrapping"): a heartbeat that has never been
 * written (missing system_state row on a fresh deploy, or a field still
 * NULL because that component has not had its first tick yet) is treated as
 * fresh-unknown → ok. This keeps the endpoint non-flapping during bootstrap
 * and immediately after: the transition from "never ran" to "ran" can never
 * cross the staleness threshold. Only a timestamp that exists and has gone
 * stale degrades — a component that ran and stopped is exactly the failure
 * this endpoint exists to catch.
 *
 * D1 unreachability degrades everything: without the lightweight heartbeat
 * read there is no trustworthy freshness signal at all.
 */
import { getSystemState } from "../repositories/system";
import { logEvent } from "../lib/logging";
import type { Env } from "../env";

export const SCHEDULER_FRESHNESS_LIMIT_MS = 3 * 60 * 1000;
export const CONSUMER_FRESHNESS_LIMIT_MS = 10 * 60 * 1000;

export interface HealthChecks {
  d1: boolean;
  scheduler: boolean;
  consumer: boolean;
}

export interface HealthResult {
  status: "ok" | "degraded";
  checks: HealthChecks;
}

/** Fresh-unknown (null/missing heartbeat) counts as fresh — see module doc. */
function isFresh(at: string | null, nowMs: number, limitMs: number): boolean {
  if (at === null) return true;
  // Unparseable timestamps degrade (fail-closed): NaN <= limit is false.
  return nowMs - Date.parse(at) <= limitMs;
}

export async function evaluateHealth(env: Env, now: string): Promise<HealthResult> {
  const nowMs = Date.parse(now);

  let row: Awaited<ReturnType<typeof getSystemState>>;
  try {
    row = await getSystemState(env);
  } catch (error) {
    // D1 is the source of every other signal — without it, report degraded.
    logEvent("healthz.d1_unreachable", {
      outcome: "degraded",
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "degraded", checks: { d1: false, scheduler: false, consumer: false } };
  }

  if (row === null || row.lastSchedulerAt === null || row.lastQueueConsumerAt === null) {
    // Bootstrap marker for operators (HANDOFF §4.3): never-run components
    // are grace-ok, and the log keeps the window observable.
    logEvent("healthz.bootstrap_grace", {
      rowExists: row !== null,
      schedulerHeartbeat: row?.lastSchedulerAt ?? null,
      consumerHeartbeat: row?.lastQueueConsumerAt ?? null,
      outcome: "ok",
    });
  }

  const checks: HealthChecks = {
    d1: true,
    scheduler: isFresh(row?.lastSchedulerAt ?? null, nowMs, SCHEDULER_FRESHNESS_LIMIT_MS),
    consumer: isFresh(row?.lastQueueConsumerAt ?? null, nowMs, CONSUMER_FRESHNESS_LIMIT_MS),
  };
  const degraded = !checks.scheduler || !checks.consumer;
  return { status: degraded ? "degraded" : "ok", checks };
}
