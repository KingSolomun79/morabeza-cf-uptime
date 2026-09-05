/**
 * /api/clients routes (PRD §24). DELETE archives — never hard-deletes.
 * All mutations write audit events with the Access-derived actor email.
 */
import { Hono } from "hono";
import { z } from "zod";
import { recordAudit } from "../repositories/audit";
import {
  archiveClient,
  createClient,
  getClient,
  listClients,
  updateClient,
} from "../repositories/clients";
import { parseJsonBody, parseQuery } from "../lib/validation";
import type { AppEnv } from "../env";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const createClientSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().regex(SLUG_PATTERN, "slug must be lowercase letters, digits, and dashes").min(1).max(100),
  notes: z.string().max(2000).nullish(),
});

const updateClientSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  slug: z
    .string()
    .trim()
    .regex(SLUG_PATTERN, "slug must be lowercase letters, digits, and dashes")
    .min(1)
    .max(100)
    .optional(),
  active: z.boolean().optional(),
  notes: z.string().max(2000).nullish(),
});

const listQuerySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export const clientsRoutes = new Hono<AppEnv>();

clientsRoutes.get("/", async (c) => {
  const query = parseQuery(c, listQuerySchema);
  const data = await listClients(c.env, { includeArchived: query.includeArchived });
  return c.json({ data });
});

clientsRoutes.post("/", async (c) => {
  const body = await parseJsonBody(c, createClientSchema);
  const created = await createClient(c.env, body);
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "client.create",
    entityType: "client",
    entityId: created.id,
    summary: `created client ${created.name}`,
    metadata: { slug: created.slug },
  });
  return c.json({ data: created }, 201);
});

clientsRoutes.get("/:id", async (c) => {
  const data = await getClient(c.env, c.req.param("id"));
  return c.json({ data });
});

clientsRoutes.patch("/:id", async (c) => {
  const body = await parseJsonBody(c, updateClientSchema);
  const updated = await updateClient(c.env, c.req.param("id"), body);
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "client.update",
    entityType: "client",
    entityId: updated.id,
    summary: `updated client ${updated.name}`,
    metadata: { fields: Object.keys(body).join(",") },
  });
  return c.json({ data: updated });
});

clientsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const archived = await archiveClient(c.env, id);
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "client.archive",
    entityType: "client",
    entityId: id,
    summary: `archived client ${archived.name}`,
  });
  return c.json({ data: archived });
});
