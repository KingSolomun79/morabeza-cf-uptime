/**
 * Incident lifecycle (issue #13; PRD §12.3, §17.5, §37.2).
 *
 * Subscribes to #12's transition seam via the default post-CAS pipeline in
 * queue/handlers/monitor-check.ts:
 * - `down` (threshold crossing) → open ONE incident per monitor. The claim is
 *   the insert itself: migration 0001's partial unique index
 *   `incidents_one_open_per_monitor_idx` makes a second open incident
 *   physically impossible, so a repeated DOWN crossing (or a hypothetical
 *   duplicate seam delivery) loses the insert and no-ops — §37.2 dedupe by
 *   construction.
 * - `recovered` → resolve the open incident with the true outage duration;
 *   idempotent because only a row still `open` can resolve.
 * - `up` (unknown→up) → deliberately nothing: no incident, no recovery
 *   (PRD §12.5).
 *
 * The monitor_state.open_incident_id link is maintained with a CONDITIONAL
 * update that never touches state_version — the state machine owns versions
 * and the pointer has no ordering semantics (§16.5). Read APIs (PRD §24)
 * live here too: open-first listing + pagination for histories that grow
 * large (§27.7, §24 pagination note).
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { incidents, monitorState } from "../../db/schema";
import { getDb } from "../lib/db";
import type { AppDatabase } from "../lib/db";
import type { Env } from "../env";
import { logEvent } from "../lib/logging";
import { newId } from "../lib/ids";
import type { StateTransitionEvent } from "./state-evaluation";

export type IncidentRow = typeof incidents.$inferSelect;

export interface IncidentDto {
  id: string;
  monitorId: string;
  status: "open" | "resolved" | "closed_admin";
  openedAt: string;
  firstFailureAt: string;
  resolvedAt: string | null;
  triggerCheckId: string | null;
  recoveryCheckId: string | null;
  openReasonCode: string | null;
  outageDurationMs: number | null;
  resolutionReason: "recovered" | "monitor_disabled" | "admin" | null;
  createdAt: string;
  updatedAt: string;
}

export function toIncidentDto(row: IncidentRow): IncidentDto {
  return {
    id: row.id,
    monitorId: row.monitorId,
    status: row.status as IncidentDto["status"],
    openedAt: row.openedAt,
    firstFailureAt: row.firstFailureAt,
    resolvedAt: row.resolvedAt,
    triggerCheckId: row.triggerCheckId,
    recoveryCheckId: row.recoveryCheckId,
    openReasonCode: row.openReasonCode,
    outageDurationMs: row.outageDurationMs,
    resolutionReason: row.resolutionReason as IncidentDto["resolutionReason"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Transition-seam subscriber: switch on the transition type and keep the
 * incident table consistent with it. Never throws for expected conditions —
 * unexpected DB failures propagate and are isolated by the seam's listener
 * guard (state.transition_listener_failed), per the listener contract.
 */
export async function handleIncidentLifecycle(db: AppDatabase, event: StateTransitionEvent): Promise<void> {
  switch (event.transition.type) {
    case "down":
      await openIncidentForDown(db, event);
      return;
    case "recovered":
      await resolveIncidentForRecovery(db, event);
      return;
    case "up":
      // unknown→up: no incident was open by definition (PRD §12.5).
      return;
  }
}

/** DOWN crossing: claim the incident, then link it into monitor_state. */
async function openIncidentForDown(db: AppDatabase, event: StateTransitionEvent): Promise<void> {
  const at = event.at;
  // §37.2: the insert IS the claim. A lost insert means an incident is
  // already open for this monitor (partial unique index) — idempotent no-op.
  const claimed = await db
    .insert(incidents)
    .values({
      id: newId("inc"),
      monitorId: event.monitorId,
      status: "open",
      openedAt: at,
      firstFailureAt: event.transition.failureSequenceStartedAt ?? at,
      triggerCheckId: event.checkId,
      openReasonCode: event.reasonCode,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .returning({ id: incidents.id });

  if (claimed.length === 0) {
    logEvent("incident.open_skipped", {
      incidentId: null,
      monitorId: event.monitorId,
      checkId: event.checkId,
      outcome: "already_open",
    });
    return;
  }

  const incidentId = claimed[0].id;
  // Conditional link, no state_version bump: the machine owns versions and
  // the pointer carries no ordering semantics (§16.5).
  await db
    .update(monitorState)
    .set({ openIncidentId: incidentId, updatedAt: at })
    .where(and(eq(monitorState.monitorId, event.monitorId), isNull(monitorState.openIncidentId)));

  logEvent("incident.opened", {
    incidentId,
    monitorId: event.monitorId,
    checkId: event.checkId,
    firstFailureAt: event.transition.failureSequenceStartedAt ?? at,
    reasonCode: event.reasonCode,
    outcome: "ok",
  });
}

/** RECOVERED crossing: resolve the open incident (once), then clear the link. */
async function resolveIncidentForRecovery(db: AppDatabase, event: StateTransitionEvent): Promise<void> {
  const [open] = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.monitorId, event.monitorId), eq(incidents.status, "open")));

  if (!open) {
    // Already resolved (redelivery/repeat) or never opened — nothing to do.
    logEvent("incident.resolve_skipped", {
      incidentId: null,
      monitorId: event.monitorId,
      checkId: event.checkId,
      outcome: "no_open_incident",
    });
    return;
  }

  const outageDurationMs = Math.max(0, Date.parse(event.at) - Date.parse(open.openedAt));
  // The `status='open'` guard makes resolution idempotent under concurrency.
  const resolved = await db
    .update(incidents)
    .set({
      status: "resolved",
      resolvedAt: event.at,
      recoveryCheckId: event.checkId,
      outageDurationMs,
      resolutionReason: "recovered",
      updatedAt: event.at,
    })
    .where(and(eq(incidents.id, open.id), eq(incidents.status, "open")))
    .returning({ id: incidents.id });

  if (resolved.length === 0) return; // a concurrent writer resolved it first

  await db
    .update(monitorState)
    .set({ openIncidentId: null, updatedAt: event.at })
    .where(and(eq(monitorState.monitorId, event.monitorId), eq(monitorState.openIncidentId, open.id)));

  logEvent("incident.resolved", {
    incidentId: open.id,
    monitorId: event.monitorId,
    checkId: event.checkId,
    outageDurationMs,
    outcome: "ok",
  });
}

export interface IncidentListQuery {
  limit: number;
  offset: number;
  /** Optional monitor scoping (#24 detail page); absent = all monitors. */
  monitorId?: string;
}

/**
 * Incident list for operators (PRD §24, §27.7): open first, then resolved,
 * newest-opened within each group. Paginated with a total count — histories
 * grow without bound (§24 pagination note).
 */
export async function listIncidents(
  env: Env,
  query: IncidentListQuery,
): Promise<{ items: IncidentDto[]; total: number }> {
  const db = getDb(env);
  const openFirst = sql`CASE WHEN ${incidents.status} = 'open' THEN 0 ELSE 1 END`;
  const where = query.monitorId ? eq(incidents.monitorId, query.monitorId) : undefined;
  const rows = await db
    .select()
    .from(incidents)
    .where(where)
    // id as the final tiebreaker keeps pagination stable for equal timestamps.
    .orderBy(openFirst, desc(incidents.openedAt), desc(incidents.id))
    .limit(query.limit)
    .offset(query.offset);
  const [countRow] = await db.select({ value: sql<number>`count(*)` }).from(incidents).where(where);
  return { items: rows.map(toIncidentDto), total: Number(countRow.value) };
}

export async function getIncident(env: Env, id: string): Promise<IncidentDto | null> {
  const [row] = await getDb(env).select().from(incidents).where(eq(incidents.id, id));
  return row ? toIncidentDto(row) : null;
}
