/**
 * Heartbeat freshness — the ONE shared law (issue #26 implementation note;
 * extracted from #11's healthz so the system page cannot drift from it).
 *
 * Freshness semantics (PRD §19 "after bootstrapping"): a heartbeat that has
 * never been written (missing system_state row, or a field still NULL) is
 * fresh-unknown → fresh. This keeps /healthz non-flapping during bootstrap.
 * Only a timestamp that exists and has gone stale is stale — a component
 * that ran and stopped is exactly the failure these checks exist to catch.
 * Unparseable timestamps fail closed (stale).
 *
 * Limits: scheduler/consumer values are the #11 contract. The housekeeping
 * limits derive from the deterministic scheduler slots (#12): hourly rollup
 * @ :05 → 2h covers a missed run plus one; daily rollup @ 00:06 and cleanup
 * @ 00:07 → 26h covers a missed day.
 */

export const SCHEDULER_FRESHNESS_LIMIT_MS = 3 * 60 * 1000;
export const CONSUMER_FRESHNESS_LIMIT_MS = 10 * 60 * 1000;
export const HOURLY_ROLLUP_FRESHNESS_LIMIT_MS = 2 * 60 * 60 * 1000;
export const DAILY_ROLLUP_FRESHNESS_LIMIT_MS = 26 * 60 * 60 * 1000;
export const CLEANUP_FRESHNESS_LIMIT_MS = 26 * 60 * 60 * 1000;

/** Three-state view for operator UIs; /healthz collapses never_run → fresh. */
export type HeartbeatStatus = "fresh" | "stale" | "never_run";

export function isHeartbeatFresh(at: string | null, nowMs: number, limitMs: number): boolean {
  return heartbeatStatus(at, nowMs, limitMs) !== "stale";
}

export function heartbeatStatus(at: string | null, nowMs: number, limitMs: number): HeartbeatStatus {
  if (at === null) return "never_run";
  const parsed = Date.parse(at);
  // NaN comparisons are false → fail closed: treat unparseable as stale.
  if (Number.isNaN(parsed)) return "stale";
  return nowMs - parsed <= limitMs ? "fresh" : "stale";
}
