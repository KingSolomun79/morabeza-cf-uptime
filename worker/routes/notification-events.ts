/**
 * GET /api/notification-events (issue #26; PRD §27.9): the delivery log —
 * notification_events rows with status/attempts/last_error, newest first,
 * optionally scoped to one target. Read-only; the rows are written by the
 * #17 pipeline.
 */
import { Hono } from "hono";
import { z } from "zod";
import { listNotificationEvents } from "../services/notification-events";
import { parseQuery } from "../lib/validation";
import type { AppEnv } from "../env";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  targetId: z.string().min(1).optional(),
});

export const notificationEventsRoutes = new Hono<AppEnv>();

notificationEventsRoutes.get("/", async (c) => {
  const query = parseQuery(c, listQuerySchema);
  const { items, total } = await listNotificationEvents(c.env, query);
  return c.json({ data: items, pagination: { total, limit: query.limit, offset: query.offset } });
});
