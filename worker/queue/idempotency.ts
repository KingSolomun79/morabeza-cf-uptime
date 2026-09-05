/**
 * Infra-level idempotency hook (issue #8; PRD §16.3/§16.4).
 *
 * Handlers claim their side effect by inserting the row keyed by the job's
 * DETERMINISTIC unique key (e.g. check_results.id = checkId). The FIRST
 * delivery inserts the row and gets `true` — it owns all further side effects
 * (state transitions, notification intents). Duplicate deliveries lose the
 * insert (unique-key conflict) and get `false`: treat the job as already
 * completed and do nothing else (PRD §16.4 step 4).
 *
 * Handlers that need multi-row side effects still claim exactly ONE row per
 * job — that row is the concurrency-safe "this job ran" marker.
 */
import { getDb } from "../lib/db";
import type { AppDatabase } from "../lib/db";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Env } from "../env";

export async function claimUniqueRow(
  env: Env,
  table: SQLiteTable,
  values: Record<string, unknown>,
  db?: AppDatabase,
): Promise<boolean> {
  const database = db ?? getDb(env);
  const inserted = await database
    .insert(table)
    .values(values as never)
    .onConflictDoNothing()
    .returning();
  return inserted.length > 0;
}
