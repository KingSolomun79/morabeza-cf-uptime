/**
 * monitor_state persistence adapter (issue #12; PRD §16.5, §17.3).
 *
 * Out-of-order protection is compare-and-set: every update carries the
 * `state_version` it was computed against and bumps it. The UPDATE only lands
 * when the version still matches — a concurrent/late writer that read older
 * state loses the CAS (0 rows), re-reads, and re-evaluates against fresh
 * state or drops as history-only. A late older result can therefore never
 * roll state backwards (PRD §16.5).
 */
import { and, eq } from "drizzle-orm";
import { monitorState } from "../../db/schema";
import type { AppDatabase } from "../lib/db";
import type { MachineState, MonitorStatus } from "../services/state-machine";

export type MonitorStateRow = typeof monitorState.$inferSelect;

/** Patch applied through the CAS — diagnostics + machine fields, never ids. */
export type MonitorStatePatch = Partial<Omit<typeof monitorState.$inferInsert, "monitorId" | "stateVersion">>;

export async function getMonitorStateRow(db: AppDatabase, monitorId: string): Promise<MonitorStateRow | null> {
  const [row] = await db.select().from(monitorState).where(eq(monitorState.monitorId, monitorId));
  return row ?? null;
}

/**
 * Loads the state row, lazily creating the §12.2 initial state (unknown,
 * counters 0) when the monitor predates its row or was inserted without one.
 */
export async function ensureMonitorStateRow(db: AppDatabase, monitorId: string, now: string): Promise<MonitorStateRow> {
  await db
    .insert(monitorState)
    .values({ monitorId, status: "unknown", updatedAt: now })
    .onConflictDoNothing();
  const row = await getMonitorStateRow(db, monitorId);
  if (!row) throw new Error(`monitor_state row missing for ${monitorId} after ensure`);
  return row;
}

/**
 * Compare-and-set update: applies `patch` + bumps state_version only while
 * the row still carries `expectedStateVersion`. Returns false when another
 * writer won the race — the caller must re-read and re-decide; it must NEVER
 * blind-overwrite (PRD §16.5).
 */
export async function casUpdateMonitorState(
  db: AppDatabase,
  monitorId: string,
  expectedStateVersion: number,
  patch: MonitorStatePatch,
): Promise<boolean> {
  const claimed = await db
    .update(monitorState)
    .set({ ...patch, stateVersion: expectedStateVersion + 1 })
    .where(and(eq(monitorState.monitorId, monitorId), eq(monitorState.stateVersion, expectedStateVersion)))
    .returning({ monitorId: monitorState.monitorId });
  return claimed.length > 0;
}

/** Projects the machine-relevant slice of a row (pure — see state-machine.ts). */
export function toMachineState(row: MonitorStateRow): MachineState {
  return {
    status: row.status as MonitorStatus,
    consecutiveFailures: row.consecutiveFailures,
    consecutiveSuccesses: row.consecutiveSuccesses,
    failureSequenceStartedAt: row.failureSequenceStartedAt,
  };
}
