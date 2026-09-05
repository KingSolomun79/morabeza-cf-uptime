/**
 * System state repository (PRD §17.13): single-row heartbeat/config
 * projection. Rows are upserted lazily — the projection exists once the first
 * heartbeat lands.
 */
import { eq } from "drizzle-orm";
import { systemState } from "../../db/schema";
import { getDb } from "../lib/db";
import { nowIso } from "../lib/time";
import type { Env } from "../env";

export const SYSTEM_STATE_ID = "system";

export async function touchQueueConsumerHeartbeat(env: Env, at: string = nowIso()): Promise<void> {
  const db = getDb(env);
  const now = nowIso();
  await db
    .insert(systemState)
    .values({ id: SYSTEM_STATE_ID, lastQueueConsumerAt: at, updatedAt: now })
    .onConflictDoUpdate({
      target: systemState.id,
      set: { lastQueueConsumerAt: at, updatedAt: now },
    });
}

export async function touchSchedulerHeartbeat(env: Env, at: string = nowIso()): Promise<void> {
  const db = getDb(env);
  const now = nowIso();
  await db
    .insert(systemState)
    .values({ id: SYSTEM_STATE_ID, lastSchedulerAt: at, updatedAt: now })
    .onConflictDoUpdate({
      target: systemState.id,
      set: { lastSchedulerAt: at, updatedAt: now },
    });
}

export async function getSystemState(env: Env): Promise<typeof systemState.$inferSelect | null> {
  const db = getDb(env);
  const [row] = await db.select().from(systemState).where(eq(systemState.id, SYSTEM_STATE_ID));
  return row ?? null;
}
