/**
 * Audit event repository (PRD §17.14, §29.18): every admin mutation gets an
 * audit row with the Access-derived actor email. Audit metadata must not
 * contain sensitive request bodies or secret headers.
 */
import { getDb } from "../lib/db";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";
import { auditEvents } from "../../db/schema";
import type { Env } from "../env";

export interface AuditInput {
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

export async function recordAudit(env: Env, input: AuditInput): Promise<void> {
  const db = getDb(env);
  await db.insert(auditEvents).values({
    id: newId("aud"),
    actorEmail: input.actorEmail,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary: input.summary ?? null,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt: nowIso(),
  });
}
