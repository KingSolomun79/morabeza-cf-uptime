/**
 * GET /api/system (issue #26; PRD §24, §27.10): the authenticated system
 * report — heartbeats with shared freshness law, D1 reachability, effective
 * retention policy, unresolved dead-letter count, build metadata. Read-only;
 * authenticated like every /api route (requireAccess on the group).
 */
import { Hono } from "hono";
import { nowIso } from "../lib/time";
import { getSystemReport } from "../services/system";
import type { AppEnv } from "../env";

export const systemRoutes = new Hono<AppEnv>();

systemRoutes.get("/", async (c) => {
  const data = await getSystemReport(c.env, nowIso());
  return c.json({ data });
});
