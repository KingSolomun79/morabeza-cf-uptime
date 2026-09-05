/**
 * Monitors repository (issues #5; PRD §17.2, §17.3, §23, §24).
 *
 * Lifecycle semantics (PRD §23):
 * - create → monitor_state row with status=unknown, counters 0 (§12.2),
 *   next_check_at=now so the scheduler picks it up promptly;
 * - disable → state paused, counters reset, open incident closed
 *   (closed_admin + monitor_disabled), NO recovery notification;
 * - re-enable → state unknown, counters reset, next_check_at=now;
 * - archive → disable + archived_at; history is never hard-deleted (§42.17).
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { clients, incidents, monitorState, monitors } from "../../db/schema";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";
import { getDb } from "../lib/db";
import type { Env } from "../env";
import type { CreateMonitorInput, UpdateMonitorInput } from "../lib/monitor-schema";

export interface MonitorStateDto {
  status: string;
  lastCheckedAt: string | null;
  lastStatusCode: number | null;
  lastResponseTimeMs: number | null;
  lastReasonCode: string | null;
}

export interface MonitorDto {
  id: string;
  clientId: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  requestBody: string | null;
  expectedStatusCodes: number[];
  bodyContains: string | null;
  bodyNotContains: string | null;
  maxResponseTimeMs: number | null;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  cacheBust: boolean;
  enabled: boolean;
  tags: string[] | null;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  state: MonitorStateDto | null;
}

export interface ListMonitorsOptions {
  includeArchived?: boolean;
  clientId?: string;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toDto(row: typeof monitors.$inferSelect, state: typeof monitorState.$inferSelect | null): MonitorDto {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    url: row.url,
    method: row.method,
    headers: parseJson(row.headersJson, null),
    requestBody: row.requestBody,
    expectedStatusCodes: parseJson(row.expectedStatusCodesJson, [200]),
    bodyContains: row.bodyContains,
    bodyNotContains: row.bodyNotContains,
    maxResponseTimeMs: row.maxResponseTimeMs,
    intervalSeconds: row.intervalSeconds,
    timeoutMs: row.timeoutMs,
    failureThreshold: row.failureThreshold,
    recoveryThreshold: row.recoveryThreshold,
    cacheBust: row.cacheBust === 1,
    enabled: row.enabled === 1,
    tags: parseJson(row.tagsJson, null),
    nextCheckAt: row.nextCheckAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    state: state
      ? {
          status: state.status,
          lastCheckedAt: state.lastCheckedAt,
          lastStatusCode: state.lastStatusCode,
          lastResponseTimeMs: state.lastResponseTimeMs,
          lastReasonCode: state.lastReasonCode,
        }
      : null,
  };
}

async function loadState(env: Env, monitorId: string): Promise<typeof monitorState.$inferSelect | null> {
  const db = getDb(env);
  const [row] = await db.select().from(monitorState).where(eq(monitorState.monitorId, monitorId));
  return row ?? null;
}

export async function listMonitors(env: Env, options: ListMonitorsOptions = {}): Promise<MonitorDto[]> {
  const db = getDb(env);
  const conditions = [];
  if (!options.includeArchived) conditions.push(isNull(monitors.archivedAt));
  if (options.clientId) conditions.push(eq(monitors.clientId, options.clientId));

  const rows = await db
    .select()
    .from(monitors)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(monitors.name));

  return Promise.all(rows.map(async (row) => toDto(row, await loadState(env, row.id))));
}

export async function getMonitor(env: Env, id: string): Promise<MonitorDto> {
  const db = getDb(env);
  const [row] = await db.select().from(monitors).where(eq(monitors.id, id));
  if (!row) throw ApiError.notFound("monitor not found");
  return toDto(row, await loadState(env, id));
}

/** Raw row access for internal callers (queue handler, #9). */
export async function getMonitorRow(env: Env, id: string): Promise<typeof monitors.$inferSelect | null> {
  const db = getDb(env);
  const [row] = await db.select().from(monitors).where(eq(monitors.id, id));
  return row ?? null;
}

export async function assertClientExists(env: Env, clientId: string): Promise<void> {
  const db = getDb(env);
  const [row] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId));
  if (!row) {
    throw ApiError.validation("unknown client", [
      { path: "clientId", message: `client ${clientId} does not exist` },
    ]);
  }
}

/** Probable duplicate = same client + URL + method among non-archived monitors (PRD §17.2). */
export async function findProbableDuplicate(
  env: Env,
  input: { clientId: string; url: string; method: string; exceptId?: string },
): Promise<string | null> {
  const db = getDb(env);
  const rows = await db
    .select({ id: monitors.id, name: monitors.name })
    .from(monitors)
    .where(
      and(
        eq(monitors.clientId, input.clientId),
        eq(monitors.url, input.url),
        eq(monitors.method, input.method),
        isNull(monitors.archivedAt),
      ),
    );
  const match = rows.find((row) => row.id !== input.exceptId);
  return match ? match.id : null;
}

export async function createMonitor(env: Env, input: CreateMonitorInput): Promise<MonitorDto> {
  await assertClientExists(env, input.clientId);
  const db = getDb(env);
  const now = nowIso();
  const id = newId("mon");

  const [row] = await db
    .insert(monitors)
    .values({
      id,
      clientId: input.clientId,
      name: input.name,
      url: input.url,
      method: input.method,
      headersJson: input.headers ? JSON.stringify(input.headers) : null,
      requestBody: input.requestBody,
      expectedStatusCodesJson: JSON.stringify(input.expectedStatusCodes),
      bodyContains: input.bodyContains,
      bodyNotContains: input.bodyNotContains,
      maxResponseTimeMs: input.maxResponseTimeMs,
      intervalSeconds: input.intervalSeconds,
      timeoutMs: input.timeoutMs,
      failureThreshold: input.failureThreshold,
      recoveryThreshold: input.recoveryThreshold,
      cacheBust: input.cacheBust ? 1 : 0,
      enabled: 1,
      nextCheckAt: now,
      tagsJson: input.tags ? JSON.stringify(input.tags) : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await db.insert(monitorState).values({
    monitorId: id,
    status: "unknown",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    updatedAt: now,
  });

  return toDto(row, await loadState(env, id));
}

/**
 * Applies config changes plus the enable/disable semantics of PRD §23.
 */
export async function updateMonitor(env: Env, id: string, input: UpdateMonitorInput): Promise<MonitorDto> {
  const existing = await getMonitor(env, id);
  if (input.clientId && input.clientId !== existing.clientId) {
    await assertClientExists(env, input.clientId);
  }

  const db = getDb(env);
  const now = nowIso();
  const enabledChanged = input.enabled !== undefined && input.enabled !== existing.enabled;

  await db
    .update(monitors)
    .set({
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.headers !== undefined ? { headersJson: input.headers ? JSON.stringify(input.headers) : null } : {}),
      ...(input.requestBody !== undefined ? { requestBody: input.requestBody } : {}),
      ...(input.expectedStatusCodes !== undefined
        ? { expectedStatusCodesJson: JSON.stringify(input.expectedStatusCodes) }
        : {}),
      ...(input.bodyContains !== undefined ? { bodyContains: input.bodyContains } : {}),
      ...(input.bodyNotContains !== undefined ? { bodyNotContains: input.bodyNotContains } : {}),
      ...(input.maxResponseTimeMs !== undefined ? { maxResponseTimeMs: input.maxResponseTimeMs } : {}),
      ...(input.intervalSeconds !== undefined ? { intervalSeconds: input.intervalSeconds } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.failureThreshold !== undefined ? { failureThreshold: input.failureThreshold } : {}),
      ...(input.recoveryThreshold !== undefined ? { recoveryThreshold: input.recoveryThreshold } : {}),
      ...(input.cacheBust !== undefined ? { cacheBust: input.cacheBust ? 1 : 0 } : {}),
      ...(input.tags !== undefined ? { tagsJson: input.tags ? JSON.stringify(input.tags) : null } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
      // Re-enabled monitors are due immediately (PRD §23).
      ...(enabledChanged && input.enabled === true ? { nextCheckAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(monitors.id, id));

  if (enabledChanged) {
    const state = await loadState(env, id);
    if (input.enabled === true) {
      // Re-enable → unknown + counters reset (PRD §23).
      if (state) {
        await db
          .update(monitorState)
          .set({
            status: "unknown",
            consecutiveFailures: 0,
            consecutiveSuccesses: 0,
            failureSequenceStartedAt: null,
            stateVersion: state.stateVersion + 1,
            updatedAt: now,
          })
          .where(eq(monitorState.monitorId, id));
      }
    } else {
      // Disable → paused + counters reset + close open incident (PRD §23).
      const [openIncident] = await db
        .select()
        .from(incidents)
        .where(and(eq(incidents.monitorId, id), eq(incidents.status, "open")));

      const stateUpdate = db
        .update(monitorState)
        .set({
          status: "paused",
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
          failureSequenceStartedAt: null,
          openIncidentId: null,
          stateVersion: (state?.stateVersion ?? 0) + 1,
          updatedAt: now,
        })
        .where(eq(monitorState.monitorId, id));

      if (openIncident) {
        const incidentUpdate = db
          .update(incidents)
          .set({
            status: "closed_admin",
            resolvedAt: now,
            resolutionReason: "monitor_disabled",
            outageDurationMs: Math.max(0, Date.parse(now) - Date.parse(openIncident.openedAt)),
            updatedAt: now,
          })
          .where(eq(incidents.id, openIncident.id));
        // Atomic-ish: state flip and incident closure land together.
        await db.batch([stateUpdate, incidentUpdate] as const);
      } else {
        await stateUpdate;
      }
    }
  }

  return getMonitor(env, id);
}

/** Archive (PRD §23): disables first, then marks archived; history preserved. */
export async function archiveMonitor(env: Env, id: string): Promise<MonitorDto> {
  const existing = await getMonitor(env, id);
  if (!existing.archivedAt) {
    if (existing.enabled) {
      await updateMonitor(env, id, { enabled: false });
    }
    const db = getDb(env);
    await db
      .update(monitors)
      .set({ archivedAt: nowIso(), updatedAt: nowIso() })
      .where(and(eq(monitors.id, id), isNull(monitors.archivedAt)));
  }
  return getMonitor(env, id);
}
