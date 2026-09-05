/**
 * Maintenance windows repository (issue #15; PRD §14, §17.6).
 *
 * Windows are an overlay on the check pipeline, never a monitor status (PRD
 * §12.1). Resolution (findActiveMaintenanceWindow) runs once per check — it
 * must stay cheap: one indexed query over (scope_type, scope_id) with the
 * time bounds and the cancelled guard as residual predicates (PRD §36).
 *
 * Nothing is hard-deleted (PRD §42.17): DELETE cancels by setting
 * cancelled_at; cancelled windows never match again.
 */
import { and, desc, eq, gt, isNull, lte, or, type SQL } from "drizzle-orm";
import { clients, maintenanceWindows, monitors } from "../../db/schema";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";
import { getDb } from "../lib/db";
import type { AppDatabase } from "../lib/db";
import type { Env } from "../env";
import type { CreateMaintenanceInput, MaintenanceScopeType, UpdateMaintenanceInput } from "../lib/maintenance-schema";
import { findMaintenanceConflicts } from "../lib/maintenance-schema";

export type MaintenanceWindowRow = typeof maintenanceWindows.$inferSelect;

export interface MaintenanceWindowDto {
  id: string;
  title: string;
  description: string | null;
  scopeType: MaintenanceScopeType;
  scopeId: string | null;
  startsAt: string;
  endsAt: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

function toDto(row: MaintenanceWindowRow): MaintenanceWindowDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    scopeType: row.scopeType as MaintenanceScopeType,
    scopeId: row.scopeId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cancelledAt: row.cancelledAt,
  };
}

/** Valid reference = row exists (§14.2); existence is cheap and sufficient in V1. */
async function assertScopeReference(db: AppDatabase, scopeType: MaintenanceScopeType, scopeId: string | null): Promise<void> {
  if (scopeType === "global") return;
  if (!scopeId) {
    throw ApiError.validation("maintenance window is invalid", [
      { path: "scopeId", message: `${scopeType} windows require a scopeId` },
    ]);
  }
  if (scopeType === "client") {
    const [row] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, scopeId));
    if (!row) {
      throw ApiError.validation("maintenance window is invalid", [
        { path: "scopeId", message: `client ${scopeId} does not exist` },
      ]);
    }
    return;
  }
  const [row] = await db.select({ id: monitors.id }).from(monitors).where(eq(monitors.id, scopeId));
  if (!row) {
    throw ApiError.validation("maintenance window is invalid", [
      { path: "scopeId", message: `monitor ${scopeId} does not exist` },
    ]);
  }
}

export async function listMaintenanceWindows(env: Env): Promise<MaintenanceWindowDto[]> {
  // V1: unpaginated like the monitors list; this table grows forever (§42.17),
  // so #25's UI should add cursor pagination if it renders long histories.
  const db = getDb(env);
  const rows = await db.select().from(maintenanceWindows).orderBy(desc(maintenanceWindows.startsAt));
  return rows.map(toDto);
}

export async function getMaintenanceWindow(env: Env, id: string): Promise<MaintenanceWindowDto> {
  const db = getDb(env);
  const [row] = await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, id));
  if (!row) throw ApiError.notFound("maintenance window not found");
  return toDto(row);
}

export async function createMaintenanceWindow(
  env: Env,
  input: CreateMaintenanceInput,
  req: { actorEmail: string | null },
): Promise<MaintenanceWindowDto> {
  const db = getDb(env);
  const scopeId = input.scopeId ?? null;
  await assertScopeReference(db, input.scopeType, scopeId);

  const now = nowIso();
  const [row] = await db
    .insert(maintenanceWindows)
    .values({
      id: newId("win"),
      title: input.title,
      description: input.description ?? null,
      scopeType: input.scopeType,
      scopeId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdBy: req.actorEmail,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toDto(row);
}

export async function updateMaintenanceWindow(
  env: Env,
  id: string,
  input: UpdateMaintenanceInput,
): Promise<MaintenanceWindowDto> {
  const db = getDb(env);
  const [row] = await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, id));
  if (!row) throw ApiError.notFound("maintenance window not found");
  if (row.cancelledAt) throw ApiError.conflict("maintenance window is cancelled — cancelled windows are terminal");

  const merged = {
    scopeType: (input.scopeType ?? row.scopeType) as MaintenanceScopeType,
    scopeId: input.scopeId !== undefined ? (input.scopeId ?? null) : row.scopeId,
    startsAt: input.startsAt ?? row.startsAt,
    endsAt: input.endsAt ?? row.endsAt,
  };
  const conflict = findMaintenanceConflicts(merged);
  if (conflict) {
    throw ApiError.validation("maintenance window is invalid", [conflict]);
  }
  await assertScopeReference(db, merged.scopeType, merged.scopeId);

  const now = nowIso();
  const [updated] = await db
    .update(maintenanceWindows)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      scopeType: merged.scopeType,
      scopeId: merged.scopeId,
      startsAt: merged.startsAt,
      endsAt: merged.endsAt,
      updatedAt: now,
    })
    .where(eq(maintenanceWindows.id, id))
    .returning();
  return toDto(updated);
}

/**
 * DELETE = cancel (PRD §24): cancelled_at is set, the row is kept forever.
 * Idempotent — `alreadyCancelled` lets callers audit only the first transition.
 */
export async function cancelMaintenanceWindow(
  env: Env,
  id: string,
): Promise<{ window: MaintenanceWindowDto; alreadyCancelled: boolean }> {
  const db = getDb(env);
  const [row] = await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, id));
  if (!row) throw ApiError.notFound("maintenance window not found");
  if (row.cancelledAt) {
    return { window: toDto(row), alreadyCancelled: true };
  }
  const now = nowIso();
  const [updated] = await db
    .update(maintenanceWindows)
    .set({ cancelledAt: now, updatedAt: now })
    .where(eq(maintenanceWindows.id, id))
    .returning();
  return { window: toDto(updated), alreadyCancelled: false };
}

export interface WindowScope {
  monitorId: string;
  clientId: string;
}

/**
 * The check-pipeline resolver: is ANY window live for this monitor at time
 * `at`? All three scopes in one indexed query (PRD §14.2): global hits every
 * monitor, client scope hits the monitor's client, monitor scope hits the
 * monitor itself. Any active window ⇒ excluded (§14.1); cancelled windows
 * never match; a window is live for starts_at <= at < ends_at.
 */
export async function findActiveMaintenanceWindow(
  db: AppDatabase,
  scope: WindowScope,
  at: string,
): Promise<MaintenanceWindowRow | null> {
  const conditions: SQL[] = [
    isNull(maintenanceWindows.cancelledAt),
    lte(maintenanceWindows.startsAt, at),
    gt(maintenanceWindows.endsAt, at),
    or(
      eq(maintenanceWindows.scopeType, "global"),
      and(eq(maintenanceWindows.scopeType, "client"), eq(maintenanceWindows.scopeId, scope.clientId)),
      and(eq(maintenanceWindows.scopeType, "monitor"), eq(maintenanceWindows.scopeId, scope.monitorId)),
    ) as SQL,
  ];
  const [row] = await db
    .select()
    .from(maintenanceWindows)
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}
