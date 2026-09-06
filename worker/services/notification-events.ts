/**
 * Delivery-log reads (issue #26; PRD §27.9): the notification_events rows
 * #17 writes — status/attempts/last_error surfaced so operators can see
 * failed sends without D1 access. Newest-first with the standard id
 * tiebreaker; optional target scoping for the per-target history view.
 */
import { desc, eq, sql } from "drizzle-orm";
import { notificationEvents, notificationTargets } from "../../db/schema";
import { getDb } from "../lib/db";
import type { Env } from "../env";

export interface NotificationEventDto {
  id: string;
  monitorId: string | null;
  incidentId: string | null;
  targetId: string;
  targetEmail: string;
  type: string; // down | recovered | test
  status: string; // pending | sending | sent | failed
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

function toDto(
  row: typeof notificationEvents.$inferSelect,
  targetEmail: string,
): NotificationEventDto {
  return {
    id: row.id,
    monitorId: row.monitorId,
    incidentId: row.incidentId,
    targetId: row.targetId,
    targetEmail,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  };
}

export interface NotificationEventListQuery {
  limit: number;
  offset: number;
  targetId?: string;
}

export async function listNotificationEvents(
  env: Env,
  query: NotificationEventListQuery,
): Promise<{ items: NotificationEventDto[]; total: number }> {
  const db = getDb(env);
  const where = query.targetId ? eq(notificationEvents.targetId, query.targetId) : undefined;
  const rows = await db
    .select({ event: notificationEvents, targetEmail: notificationTargets.email })
    .from(notificationEvents)
    .innerJoin(notificationTargets, eq(notificationEvents.targetId, notificationTargets.id))
    .where(where)
    .orderBy(desc(notificationEvents.createdAt), desc(notificationEvents.id))
    .limit(query.limit)
    .offset(query.offset);
  const [countRow] = await db
    .select({ value: sql<number>`count(*)` })
    .from(notificationEvents)
    .where(where);
  return { items: rows.map((row) => toDto(row.event, row.targetEmail)), total: Number(countRow.value) };
}
