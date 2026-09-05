/**
 * Clients repository (PRD §17.1, §24). Archive-only deletion: normal flows
 * never hard-delete operational records (PRD §42.17).
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { clients } from "../../db/schema";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";
import { getDb } from "../lib/db";
import type { Env } from "../env";

export interface ClientDto {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateClientInput {
  name: string;
  slug: string;
  notes?: string | null;
}

export interface UpdateClientInput {
  name?: string;
  slug?: string;
  active?: boolean;
  notes?: string | null;
}

function toDto(row: typeof clients.$inferSelect): ClientDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    active: row.active === 1,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

export async function listClients(env: Env, options: { includeArchived?: boolean } = {}): Promise<ClientDto[]> {
  const db = getDb(env);
  const rows = options.includeArchived
    ? await db.select().from(clients).orderBy(asc(clients.name))
    : await db
        .select()
        .from(clients)
        .where(isNull(clients.archivedAt))
        .orderBy(asc(clients.name));
  return rows.map(toDto);
}

export async function getClient(env: Env, id: string): Promise<ClientDto> {
  const db = getDb(env);
  const [row] = await db.select().from(clients).where(eq(clients.id, id));
  if (!row) throw ApiError.notFound("client not found");
  return toDto(row);
}

async function assertSlugAvailable(env: Env, slug: string, exceptId?: string): Promise<void> {
  const db = getDb(env);
  const rows = await db.select({ id: clients.id }).from(clients).where(eq(clients.slug, slug));
  if (rows.some((row) => row.id !== exceptId)) {
    throw ApiError.conflict(`slug "${slug}" is already in use`);
  }
}

export async function createClient(env: Env, input: CreateClientInput): Promise<ClientDto> {
  await assertSlugAvailable(env, input.slug);
  const db = getDb(env);
  const now = nowIso();
  const [row] = await db
    .insert(clients)
    .values({
      id: newId("cli"),
      name: input.name,
      slug: input.slug,
      notes: input.notes ?? null,
      active: 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toDto(row);
}

export async function updateClient(env: Env, id: string, input: UpdateClientInput): Promise<ClientDto> {
  const existing = await getClient(env, id);
  if (input.slug && input.slug !== existing.slug) {
    await assertSlugAvailable(env, input.slug, id);
  }

  const db = getDb(env);
  const [row] = await db
    .update(clients)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.active !== undefined ? { active: input.active ? 1 : 0 } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(clients.id, id))
    .returning();
  return toDto(row);
}

/** Archive (soft delete): preserves history, removes from default lists. */
export async function archiveClient(env: Env, id: string): Promise<ClientDto> {
  await getClient(env, id);
  const db = getDb(env);
  const now = nowIso();
  const [row] = await db
    .update(clients)
    .set({ archivedAt: now, active: 0, updatedAt: now })
    .where(and(eq(clients.id, id), isNull(clients.archivedAt)))
    .returning();
  if (!row) {
    // Already archived between the read and the write — idempotent archive.
    return getClient(env, id);
  }
  return toDto(row);
}
