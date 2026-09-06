/**
 * GET /api/dashboard (issue #22; PRD §24, §27.3): one aggregate response for
 * the Overview page — bounded queries, no per-monitor history fetches (§36).
 * Access-protected via the /api middleware chain in app.ts.
 */
import { Hono } from "hono";
import { getDashboard } from "../services/dashboard";
import type { AppEnv } from "../env";

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.get("/", async (c) => {
  const data = await getDashboard(c.env);
  return c.json({ data });
});
