/**
 * Dead-letter ops (issue #26; PRD §24): list the rows the DLQ consumer (#8)
 * persisted and resolve them with operator notes. Resolution is a soft
 * completion — resolvedAt + resolutionNotes, never a delete (§42.17); the
 * retention policy prunes RESOLVED rows after 30d (#19).
 */
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { deadLetterEvents } from "../../db/schema";
import { getDb } from "../lib/db";
import { nowIso } from "../lib/time";
import { ApiError } from "../lib/errors";
import type { Env } from "../env";

export interface DeadLetterDto {
  id: string;
  originalJobId: string | null;
  messageType: string | null;
  payloadSummaryJson: string | null;
  failureReason: string | null;
  receivedAt: string;
  resolvedAt: string | null;
  resolutionNotes: string | null;
}

function toDto(row: typeof deadLetterEvents.$inferSelect): DeadLetterDto {
  return { ...row };
}

export type DeadLetterFilter = "unresolved" | "resolved" | "all";

export interface DeadLetterListQuery {
  limit: number;
  offset: number;
  filter: DeadLetterFilter;
}

export async function listDeadLetters(
  env: Env,
  query: DeadLetterListQuery,
): Promise<{ items: DeadLetterDto[]; total: number }> {
  const db = getDb(env);
  const where =
    query.filter === "unresolved"
      ? isNull(deadLetterEvents.resolvedAt)
      : query.filter === "resolved"
        ? isNotNull(deadLetterEvents.resolvedAt)
        : undefined;
  const rows = await db
    .select()
    .from(deadLetterEvents)
    .where(where)
    .orderBy(desc(deadLetterEvents.receivedAt), desc(deadLetterEvents.id))
    .limit(query.limit)
    .offset(query.offset);
  const [countRow] = await db.select({ value: sql<number>`count(*)` }).from(deadLetterEvents).where(where);
  return { items: rows.map(toDto), total: Number(countRow.value) };
}

export async function resolveDeadLetter(
  env: Env,
  id: string,
  input: { notes: string | null },
): Promise<{ letter: DeadLetterDto; alreadyResolved: boolean }> {
  const db = getDb(env);
  const [existing] = await db.select().from(deadLetterEvents).where(eq(deadLetterEvents.id, id));
  if (!existing) throw ApiError.notFound("dead letter not found");
  if (existing.resolvedAt !== null) {
    // Idempotent: resolving twice keeps the FIRST resolution's timestamp and
    // notes — a re-delivery of the same operator action changes nothing.
    return { letter: toDto(existing), alreadyResolved: true };
  }

  const resolvedAt = nowIso();
  const [updated] = await db
    .update(deadLetterEvents)
    .set({ resolvedAt, resolutionNotes: input.notes })
    .where(and(eq(deadLetterEvents.id, id), isNull(deadLetterEvents.resolvedAt)))
    .returning();

  if (updated === undefined) {
    // Lost a race against a concurrent resolve (the guarded UPDATE matched
    // nothing): first resolution wins — return the winner, mark as already
    // resolved so the route audits once and surfaces the warning sibling.
    const [winner] = await db.select().from(deadLetterEvents).where(eq(deadLetterEvents.id, id));
    return { letter: toDto(winner ?? existing), alreadyResolved: true };
  }

  return { letter: toDto(updated), alreadyResolved: false };
}
