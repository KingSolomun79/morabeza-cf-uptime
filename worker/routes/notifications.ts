/**
 * Notification routing surface (issues #16 + #17; PRD §24, §27.9):
 * - /api/notification-targets — verified operational recipient records
 * - POST /api/notification-targets/:id/test — test email through the queue
 *   pipeline (never sent inline, PRD §42.14)
 * - /api/monitors/:id/notification-targets — explicit per-monitor mappings
 */
import { Hono } from "hono";
import { z } from "zod";
import { recordAudit } from "../repositories/audit";
import {
  createTarget,
  deleteTarget,
  getMonitorTargetIds,
  getTarget,
  listTargets,
  setMonitorTargets,
  updateTarget,
} from "../repositories/notifications";
import { queueTestEmail } from "../services/notifications";
import { parseJsonBody } from "../lib/validation";
import type { AppEnv } from "../env";

const createTargetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(320),
  isDefault: z.boolean().optional(),
});

const updateTargetSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.email().max(320).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

const setMappingsSchema = z.object({
  targetIds: z.array(z.string().min(1)).max(50),
});

export const notificationTargetsRoutes = new Hono<AppEnv>();

notificationTargetsRoutes.get("/", async (c) => {
  return c.json({ data: await listTargets(c.env) });
});

notificationTargetsRoutes.post("/", async (c) => {
  const body = await parseJsonBody(c, createTargetSchema);
  const created = await createTarget(c.env, body);
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "notification_target.create",
    entityType: "notification_target",
    entityId: created.id,
    summary: `created notification target ${created.email}`,
    metadata: { isDefault: created.isDefault },
  });
  return c.json({ data: created }, 201);
});

notificationTargetsRoutes.get("/:id", async (c) => {
  return c.json({ data: await getTarget(c.env, c.req.param("id")) });
});

/**
 * Test email (issue #17; PRD §24): queues a `test` event through the same
 * pipeline as alerts — the route NEVER sends inline (PRD §42.14). 202 =
 * accepted for async delivery; the eventual outcome lives on the event row.
 */
notificationTargetsRoutes.post("/:id/test", async (c) => {
  const id = c.req.param("id");
  const target = await getTarget(c.env, id); // 404 surface for unknown ids
  const { notificationEventId } = await queueTestEmail(c.env, id);
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "notification_target.test",
    entityType: "notification_target",
    entityId: id,
    summary: `queued test email to ${target.email}`,
    metadata: { notificationEventId },
  });
  return c.json({ data: { notificationEventId, queued: true } }, 202);
});

notificationTargetsRoutes.patch("/:id", async (c) => {
  const body = await parseJsonBody(c, updateTargetSchema);
  const updated = await updateTarget(c.env, c.req.param("id"), body);
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "notification_target.update",
    entityType: "notification_target",
    entityId: updated.id,
    summary: `updated notification target ${updated.email}`,
    metadata: { fields: Object.keys(body).join(",") },
  });
  return c.json({ data: updated });
});

notificationTargetsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getTarget(c.env, id);
  await deleteTarget(c.env, id);
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "notification_target.delete",
    entityType: "notification_target",
    entityId: id,
    summary: `deleted notification target ${existing.email}`,
  });
  return c.json({ data: { id, deleted: true } });
});

/** Explicit monitor→target mappings (PRD §17.8). */
export const monitorNotificationTargetsRoutes = new Hono<AppEnv>();

monitorNotificationTargetsRoutes.get("/:id/notification-targets", async (c) => {
  const monitorId = c.req.param("id");
  const data = await getMonitorTargetIds(c.env, monitorId);
  return c.json({ data, monitorId });
});

monitorNotificationTargetsRoutes.put("/:id/notification-targets", async (c) => {
  const monitorId = c.req.param("id");
  const body = await parseJsonBody(c, setMappingsSchema);
  const data = await setMonitorTargets(c.env, monitorId, body.targetIds);
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "monitor_notification_targets.set",
    entityType: "monitor",
    entityId: monitorId,
    summary: `set ${data.length} notification target mapping(s)`,
    metadata: { targetIds: data.join(",") },
  });
  return c.json({ data, monitorId });
});
