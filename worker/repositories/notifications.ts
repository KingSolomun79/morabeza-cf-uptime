/**
 * Notification recipients repository (issues #16; PRD §17.7, §17.8, §24, §27.9).
 *
 * Recipient resolution contract (PRD §17.8): if a monitor has explicit target
 * mappings, use the ENABLED ones among them (even if that yields none —
 * explicit config wins, no silent fallback); otherwise use enabled targets
 * flagged is_default. The email pipeline (#17) consumes resolveTargets().
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  monitorNotificationTargets,
  monitors,
  notificationEvents,
  notificationTargets,
} from "../../db/schema";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";
import { getDb } from "../lib/db";
import type { Env } from "../env";

export interface NotificationTargetDto {
  id: string;
  name: string;
  email: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTargetInput {
  name: string;
  email: string;
  isDefault?: boolean;
}

export interface UpdateTargetInput {
  name?: string;
  email?: string;
  enabled?: boolean;
  isDefault?: boolean;
}

function toDto(row: typeof notificationTargets.$inferSelect): NotificationTargetDto {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    enabled: row.enabled === 1,
    isDefault: row.isDefault === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listTargets(env: Env): Promise<NotificationTargetDto[]> {
  const db = getDb(env);
  const rows = await db.select().from(notificationTargets).orderBy(asc(notificationTargets.name));
  return rows.map(toDto);
}

export async function getTarget(env: Env, id: string): Promise<NotificationTargetDto> {
  const db = getDb(env);
  const [row] = await db.select().from(notificationTargets).where(eq(notificationTargets.id, id));
  if (!row) throw ApiError.notFound("notification target not found");
  return toDto(row);
}

export async function createTarget(env: Env, input: CreateTargetInput): Promise<NotificationTargetDto> {
  const db = getDb(env);
  const [existing] = await db
    .select({ id: notificationTargets.id })
    .from(notificationTargets)
    .where(eq(notificationTargets.email, input.email));
  if (existing) {
    throw ApiError.conflict(`email ${input.email} is already a notification target`);
  }

  const now = nowIso();
  const [row] = await db
    .insert(notificationTargets)
    .values({
      id: newId("tgt"),
      name: input.name,
      email: input.email,
      enabled: 1,
      isDefault: input.isDefault ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toDto(row);
}

export async function updateTarget(env: Env, id: string, input: UpdateTargetInput): Promise<NotificationTargetDto> {
  const existing = await getTarget(env, id);
  const db = getDb(env);

  if (input.email && input.email !== existing.email) {
    const [duplicate] = await db
      .select({ id: notificationTargets.id })
      .from(notificationTargets)
      .where(eq(notificationTargets.email, input.email));
    if (duplicate && duplicate.id !== id) {
      throw ApiError.conflict(`email ${input.email} is already a notification target`);
    }
  }

  const [row] = await db
    .update(notificationTargets)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault ? 1 : 0 } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(notificationTargets.id, id))
    .returning();
  if (!row) throw ApiError.notFound("notification target not found");
  return toDto(row);
}

/**
 * Deletes a target ONLY when no notification history references it —
 * notification_events are operational history and are never orphaned or
 * hard-deleted (PRD §42.17). Otherwise operators should disable the target.
 */
export async function deleteTarget(env: Env, id: string): Promise<void> {
  const db = getDb(env);
  await getTarget(env, id);

  const [referenced] = await db
    .select({ id: notificationEvents.id })
    .from(notificationEvents)
    .where(eq(notificationEvents.targetId, id))
    .limit(1);
  if (referenced) {
    throw ApiError.conflict("target has notification history; disable it instead of deleting");
  }

  await db.delete(monitorNotificationTargets).where(eq(monitorNotificationTargets.targetId, id));
  await db.delete(notificationTargets).where(eq(notificationTargets.id, id));
}

/** Explicit mappings for a monitor (any enablement state). */
export async function getMonitorTargetIds(env: Env, monitorId: string): Promise<string[]> {
  const db = getDb(env);
  const rows = await db
    .select({ targetId: monitorNotificationTargets.targetId })
    .from(monitorNotificationTargets)
    .where(eq(monitorNotificationTargets.monitorId, monitorId));
  return rows.map((row) => row.targetId);
}

/** Replaces the explicit mapping set for a monitor (PUT semantics). */
export async function setMonitorTargets(
  env: Env,
  monitorId: string,
  targetIds: string[],
): Promise<string[]> {
  const db = getDb(env);

  const [monitor] = await db.select({ id: monitors.id }).from(monitors).where(eq(monitors.id, monitorId));
  if (!monitor) throw ApiError.notFound("monitor not found");

  if (targetIds.length > 0) {
    const known = await db
      .select({ id: notificationTargets.id })
      .from(notificationTargets)
      .where(inArray(notificationTargets.id, targetIds));
    const missing = targetIds.filter((id) => !known.some((row) => row.id === id));
    if (missing.length > 0) {
      throw ApiError.validation("unknown notification target ids", missing.map((id) => ({ path: "targetIds", message: `unknown target ${id}` })));
    }
  }

  await db.delete(monitorNotificationTargets).where(eq(monitorNotificationTargets.monitorId, monitorId));
  if (targetIds.length > 0) {
    await db.insert(monitorNotificationTargets).values(
      targetIds.map((targetId) => ({ monitorId, targetId })),
    );
  }
  return targetIds;
}

/**
 * Who receives alerts for this monitor (PRD §17.8). See module doc comment.
 * The email pipeline (#17) creates one notification_events row per returned
 * target.
 */
export async function resolveTargets(
  env: Env,
  monitorId: string,
): Promise<Array<{ id: string; email: string }>> {
  const db = getDb(env);

  const explicit = await db
    .select({ id: notificationTargets.id, email: notificationTargets.email, enabled: notificationTargets.enabled })
    .from(monitorNotificationTargets)
    .innerJoin(notificationTargets, eq(notificationTargets.id, monitorNotificationTargets.targetId))
    .where(eq(monitorNotificationTargets.monitorId, monitorId));

  if (explicit.length > 0) {
    return explicit
      .filter((row) => row.enabled === 1)
      .map(({ id, email }) => ({ id, email }));
  }

  const defaults = await db
    .select({ id: notificationTargets.id, email: notificationTargets.email })
    .from(notificationTargets)
    .where(and(eq(notificationTargets.isDefault, 1), eq(notificationTargets.enabled, 1)));
  return defaults.map(({ id, email }) => ({ id, email }));
}
