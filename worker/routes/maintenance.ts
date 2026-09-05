/**
 * /api/maintenance routes (issue #15; PRD §14, §24).
 * DELETE cancels (sets cancelled_at) — hard deletion does not exist in
 * normal flows (PRD §42.17). Every mutation writes an audit event.
 */
import { Hono } from "hono";
import { recordAudit } from "../repositories/audit";
import {
  cancelMaintenanceWindow,
  createMaintenanceWindow,
  getMaintenanceWindow,
  listMaintenanceWindows,
  updateMaintenanceWindow,
} from "../repositories/maintenance";
import { createMaintenanceSchema, updateMaintenanceSchema } from "../lib/maintenance-schema";
import { parseJsonBody } from "../lib/validation";
import type { AppEnv } from "../env";

export const maintenanceRoutes = new Hono<AppEnv>();

maintenanceRoutes.get("/", async (c) => {
  const data = await listMaintenanceWindows(c.env);
  return c.json({ data });
});

maintenanceRoutes.post("/", async (c) => {
  const body = await parseJsonBody(c, createMaintenanceSchema);
  const created = await createMaintenanceWindow(c.env, body, { actorEmail: c.get("actorEmail") });
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "maintenance.create",
    entityType: "maintenance_window",
    entityId: created.id,
    summary: `created ${created.scopeType} maintenance window "${created.title}"`,
    metadata: { scopeType: created.scopeType, scopeId: created.scopeId, startsAt: created.startsAt, endsAt: created.endsAt },
  });
  return c.json({ data: created }, 201);
});

maintenanceRoutes.get("/:id", async (c) => {
  const data = await getMaintenanceWindow(c.env, c.req.param("id"));
  return c.json({ data });
});

maintenanceRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await parseJsonBody(c, updateMaintenanceSchema);
  const updated = await updateMaintenanceWindow(c.env, id, body);
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "maintenance.update",
    entityType: "maintenance_window",
    entityId: id,
    summary: `updated maintenance window "${updated.title}"`,
    metadata: { fields: Object.keys(body).join(",") },
  });
  return c.json({ data: updated });
});

maintenanceRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const { window, alreadyCancelled } = await cancelMaintenanceWindow(c.env, id);
  if (!alreadyCancelled) {
    await recordAudit(c.env, {
      actorEmail: c.get("actorEmail"),
      action: "maintenance.cancel",
      entityType: "maintenance_window",
      entityId: id,
      summary: `cancelled maintenance window "${window.title}"`,
    });
  }
  return c.json({ data: window });
});
