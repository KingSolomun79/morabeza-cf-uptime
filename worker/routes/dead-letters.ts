/**
 * Dead-letter ops routes (issue #26; PRD §24, §42.17): paginated listing of
 * the rows #8's DLQ consumer wrote, and resolve-with-notes. Resolution is
 * idempotent (a second PATCH returns the existing resolution unchanged);
 * no hard delete exists in normal flows.
 */
import { Hono } from "hono";
import { z } from "zod";
import { recordAudit } from "../repositories/audit";
import { listDeadLetters, resolveDeadLetter } from "../services/dead-letters";
import { parseJsonBody, parseQuery } from "../lib/validation";
import type { AppEnv } from "../env";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  filter: z.enum(["unresolved", "resolved", "all"]).default("unresolved"),
});

const resolveSchema = z.object({
  notes: z.string().max(2000).nullish().transform((value) => value ?? null),
});

export const deadLettersRoutes = new Hono<AppEnv>();

deadLettersRoutes.get("/", async (c) => {
  const query = parseQuery(c, listQuerySchema);
  const { items, total } = await listDeadLetters(c.env, query);
  return c.json({ data: items, pagination: { total, limit: query.limit, offset: query.offset } });
});

deadLettersRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await parseJsonBody(c, resolveSchema);
  const { letter, alreadyResolved } = await resolveDeadLetter(c.env, id, { notes: body.notes });
  if (!alreadyResolved) {
    await recordAudit(c.env, {
      actorEmail: c.get("actorEmail"),
      action: "dead_letter.resolve",
      entityType: "dead_letter_event",
      entityId: id,
      summary: `resolved dead letter ${id}${body.notes ? ` — "${body.notes}"` : ""}`,
    });
  }
  return c.json({ data: letter, warning: alreadyResolved ? "dead letter was already resolved" : undefined });
});
