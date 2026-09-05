/**
 * /api/incidents routes (issue #13; PRD §24). Read-only: the lifecycle is
 * driven by the check pipeline (#13), disable-close by #5's semantics — no
 * mutation endpoints here. Open first, then resolved (PRD §27.7), paginated
 * because incident history grows without bound (PRD §24).
 */
import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { parseQuery } from "../lib/validation";
import { getIncident, listIncidents } from "../services/incidents";
import type { AppEnv } from "../env";

export const incidentsRoutes = new Hono<AppEnv>();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

incidentsRoutes.get("/", async (c) => {
  const query = parseQuery(c, listQuerySchema);
  const { items, total } = await listIncidents(c.env, query);
  return c.json({ data: items, pagination: { total, limit: query.limit, offset: query.offset } });
});

incidentsRoutes.get("/:id", async (c) => {
  const incident = await getIncident(c.env, c.req.param("id"));
  if (!incident) {
    throw ApiError.notFound("incident not found");
  }
  return c.json({ data: incident });
});
