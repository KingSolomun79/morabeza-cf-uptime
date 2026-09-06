/**
 * /api/monitors routes (issues #5; PRD §24, §10.9, §17.2, §22, §23).
 * DELETE archives — permanent deletion does not exist in normal flows.
 */
import { Hono } from "hono";
import { z } from "zod";
import { recordAudit } from "../repositories/audit";
import {
  archiveMonitor,
  createMonitor,
  findProbableDuplicate,
  getMonitor,
  listMonitors,
  updateMonitor,
} from "../repositories/monitors";
import {
  createMonitorSchema,
  findConfigConflicts,
  findSensitiveHeader,
  updateMonitorSchema,
} from "../lib/monitor-schema";
import { ApiError } from "../lib/errors";
import { parseJsonBody, parseQuery } from "../lib/validation";
import { requestManualCheck } from "../services/manual-check";
import { getMonitorUptime, UPTIME_WINDOWS } from "../services/uptime";
import type { AppEnv } from "../env";

const listQuerySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  clientId: z.string().min(1).optional(),
});

/** Defaults to 24h so the endpoint is dashboard-friendly (PRD §24/§26). */
const uptimeQuerySchema = z.object({
  window: z.enum(UPTIME_WINDOWS).default("24h"),
});

function assertNoForbiddenConfig(input: { headers: Record<string, string> | null; method: string; requestBody: string | null }): void {
  const sensitive = findSensitiveHeader(input.headers);
  if (sensitive) {
    throw ApiError.validation("monitor config is invalid", [
      { path: "headers", message: `security-sensitive header "${sensitive}" is rejected in V1 (PRD §10.9)` },
    ]);
  }
  const conflict = findConfigConflicts(input);
  if (conflict) {
    throw ApiError.validation("monitor config is invalid", [{ path: "requestBody", message: conflict }]);
  }
}

export const monitorsRoutes = new Hono<AppEnv>();

monitorsRoutes.get("/", async (c) => {
  const query = parseQuery(c, listQuerySchema);
  const data = await listMonitors(c.env, query);
  return c.json({ data });
});

monitorsRoutes.post("/", async (c) => {
  const body = await parseJsonBody(c, createMonitorSchema);
  assertNoForbiddenConfig(body);

  const created = await createMonitor(c.env, body);
  const duplicateId = await findProbableDuplicate(c.env, {
    clientId: created.clientId,
    url: created.url,
    method: created.method,
    exceptId: created.id,
  });

  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "monitor.create",
    entityType: "monitor",
    entityId: created.id,
    summary: `created monitor ${created.name}`,
    metadata: { url: created.url, method: created.method },
  });

  return c.json(
    {
      data: created,
      ...(duplicateId
        ? { warning: `probable duplicate of monitor ${duplicateId} (same client, url, and method)` }
        : {}),
    },
    201,
  );
});

monitorsRoutes.get("/:id", async (c) => {
  const data = await getMonitor(c.env, c.req.param("id"));
  return c.json({ data });
});

monitorsRoutes.patch("/:id", async (c) => {
  const body = await parseJsonBody(c, updateMonitorSchema);

  // Validate the merged config for sensitive headers / body conflicts.
  const current = await getMonitor(c.env, c.req.param("id"));
  assertNoForbiddenConfig({
    headers: body.headers !== undefined ? body.headers : current.headers,
    method: body.method !== undefined ? body.method : current.method,
    requestBody: body.requestBody !== undefined ? body.requestBody : current.requestBody,
  });

  const updated = await updateMonitor(c.env, c.req.param("id"), body);
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "monitor.update",
    entityType: "monitor",
    entityId: updated.id,
    summary: `updated monitor ${updated.name}`,
    metadata: {
      fields: Object.keys(body).join(","),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    },
  });
  return c.json({ data: updated });
});

monitorsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const archived = await archiveMonitor(c.env, id);
  await recordAudit(c.env, {
    actorEmail: c.get("actorEmail"),
    action: "monitor.archive",
    entityType: "monitor",
    entityId: id,
    summary: `archived monitor ${archived.name}`,
  });
  return c.json({ data: archived });
});

/**
 * Run check now (issue #14; PRD §13, §24): enqueues a diagnostic-only manual
 * check and returns immediately — never a synchronous target request.
 */
monitorsRoutes.post("/:id/check", async (c) => {
  const receipt = await requestManualCheck(c.env, c.req.param("id"), {
    actorEmail: c.get("actorEmail"),
  });
  return c.json({ data: receipt }, 202);
});

/**
 * Uptime per window (issue #20; PRD §24, §26): raw checks within retention,
 * hourly rollups beyond, blended across the switchover. Unknown monitor →
 * 404 envelope; invalid window → 400 validation envelope.
 */
monitorsRoutes.get("/:id/uptime", async (c) => {
  const { window } = parseQuery(c, uptimeQuerySchema);
  const monitorId = c.req.param("id");
  await getMonitor(c.env, monitorId); // throws 404 not_found for unknown ids
  const data = await getMonitorUptime(c.env, monitorId, window);
  return c.json({ data });
});
