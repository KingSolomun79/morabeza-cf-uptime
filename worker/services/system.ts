/**
 * System report for GET /api/system (issue #26; PRD §24, §27.10): heartbeat
 * timestamps with freshness under the SHARED law (lib/heartbeat.ts), D1
 * reachability, effective retention policy, unresolved dead-letter count,
 * and build/version metadata.
 *
 * Secret hygiene (PRD §27.10): this DTO contains operator facts only —
 * no account ids, tokens, binding names, or emails. Retention values come
 * from the same parser the cleanup job uses, so the page can never show a
 * policy different from the one actually enforced (a misconfigured var
 * throws → §38 internal envelope, matching retention's fail-loud stance).
 */
import { isNull, sql } from "drizzle-orm";
import { deadLetterEvents } from "../../db/schema";
import { getDb } from "../lib/db";
import {
  CLEANUP_FRESHNESS_LIMIT_MS,
  CONSUMER_FRESHNESS_LIMIT_MS,
  DAILY_ROLLUP_FRESHNESS_LIMIT_MS,
  HOURLY_ROLLUP_FRESHNESS_LIMIT_MS,
  SCHEDULER_FRESHNESS_LIMIT_MS,
  heartbeatStatus,
  type HeartbeatStatus,
} from "../lib/heartbeat";
import { getSystemState } from "../repositories/system";
import { parseRetentionDays } from "./retention";
import type { Env } from "../env";

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
  /** Effective values (§18 defaults when the var is absent). */
  retention: { rawCheckDays: number; hourlyDays: number; dailyDays: number };
  deadLetters: { unresolved: number };
  /** wrangler var, set at deploy (#28); null before provisioning. */
  version: string | null;
  /** Whether the EMAIL binding exists — non-secret readiness fact. */
  emailConfigured: boolean;
}

export async function getSystemReport(env: Env, now: string): Promise<SystemReportDto> {
  const nowMs = Date.parse(now);

  // D1 is the source of every other signal — if this read throws, the route
  // surfaces the §38 internal envelope (fail loud, like retention).
  const row = await getSystemState(env);
  const db = getDb(env);
  const [countRow] = await db
    .select({ value: sql<number>`count(*)` })
    .from(deadLetterEvents)
    .where(isNull(deadLetterEvents.resolvedAt));

  const view = (at: string | null, limitMs: number): HeartbeatView => ({
    at,
    status: heartbeatStatus(at, nowMs, limitMs),
  });

  return {
    now,
    d1: { reachable: true },
    heartbeats: {
      scheduler: view(row?.lastSchedulerAt ?? null, SCHEDULER_FRESHNESS_LIMIT_MS),
      queueConsumer: view(row?.lastQueueConsumerAt ?? null, CONSUMER_FRESHNESS_LIMIT_MS),
      hourlyRollup: view(row?.lastHourlyRollupAt ?? null, HOURLY_ROLLUP_FRESHNESS_LIMIT_MS),
      dailyRollup: view(row?.lastDailyRollupAt ?? null, DAILY_ROLLUP_FRESHNESS_LIMIT_MS),
      cleanup: view(row?.lastCleanupAt ?? null, CLEANUP_FRESHNESS_LIMIT_MS),
    },
    retention: {
      // Same parser the cleanup job uses — a misconfigured var throws here
      // too, surfacing as the §38 internal envelope (fail loud, no page can
      // show a policy different from the one actually enforced).
      rawCheckDays: parseRetentionDays(env.RAW_CHECK_RETENTION_DAYS, "RAW_CHECK_RETENTION_DAYS", 7),
      hourlyDays: parseRetentionDays(env.HOURLY_RETENTION_DAYS, "HOURLY_RETENTION_DAYS", 90),
      dailyDays: parseRetentionDays(env.DAILY_RETENTION_DAYS, "DAILY_RETENTION_DAYS", 730),
    },
    deadLetters: { unresolved: Number(countRow.value) },
    version: env.APP_VERSION ?? null,
    emailConfigured: env.EMAIL !== undefined,
  };
}
