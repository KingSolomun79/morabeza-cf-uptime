/**
 * Check-history reads for the monitor detail page (issue #24; PRD §24, §27.5).
 *
 * A minimal, documented §24 extension: the checks list endpoint the UI
 * paginates through (and plots response times from). Read-only — results are
 * written only by the check pipeline (#9) and never mutated afterwards.
 * Ordering is `completed_at DESC, id DESC` so pagination is stable when rows
 * share a timestamp (same lexicographic-ISO conventions as #18/#20).
 */
import { desc, eq, sql } from "drizzle-orm";
import { checkResults } from "../../db/schema";
import { getDb } from "../lib/db";
import type { Env } from "../env";

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

function toCheckDto(row: typeof checkResults.$inferSelect): CheckDto {
  return {
    id: row.id,
    monitorId: row.monitorId,
    source: row.source as CheckDto["source"],
    completedAt: row.completedAt,
    isHealthy: row.isHealthy === 1,
    maintenanceExcluded: row.maintenanceExcluded === 1,
    statusCode: row.statusCode,
    responseTimeMs: row.responseTimeMs,
    reasonCode: row.reasonCode,
    errorMessage: row.errorMessage,
  };
}

export interface CheckListQuery {
  limit: number;
  offset: number;
}

export async function listMonitorChecks(
  env: Env,
  monitorId: string,
  query: CheckListQuery,
): Promise<{ items: CheckDto[]; total: number }> {
  const db = getDb(env);
  const where = eq(checkResults.monitorId, monitorId);
  const rows = await db
    .select()
    .from(checkResults)
    .where(where)
    .orderBy(desc(checkResults.completedAt), desc(checkResults.id))
    .limit(query.limit)
    .offset(query.offset);
  const [countRow] = await db
    .select({ value: sql<number>`count(*)` })
    .from(checkResults)
    .where(where);
  return { items: rows.map(toCheckDto), total: Number(countRow.value) };
}
