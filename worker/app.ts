/**
 * Worker application shell (PRD §24, §30): public /healthz + the private
 * /api surface behind the middleware chain (request id → Access auth →
 * origin check), consistent error envelopes (PRD §38), and structured
 * request logging (PRD §28).
 */
import { Hono } from "hono";
import { logEvent } from "./lib/logging";
import { nowIso } from "./lib/time";
import { errorEnvelope, ApiError } from "./lib/errors";
import { originCheck, requireAccess } from "./lib/access";
import { newId } from "./lib/ids";
import { securityHeaders } from "./lib/security-headers";
import { evaluateHealth } from "./services/healthz";
import { clientsRoutes } from "./routes/clients";
import { monitorsRoutes } from "./routes/monitors";
import { maintenanceRoutes } from "./routes/maintenance";
import { incidentsRoutes } from "./routes/incidents";
import { dashboardRoutes } from "./routes/dashboard";
import { monitorNotificationTargetsRoutes, notificationTargetsRoutes } from "./routes/notifications";
import { notificationEventsRoutes } from "./routes/notification-events";
import { systemRoutes } from "./routes/system";
import { deadLettersRoutes } from "./routes/dead-letters";
import type { AppEnv } from "./env";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Security headers on every Worker-generated response (issue #28; PRD
  // §29.11–14): CSP incl. frame-ancestors, nosniff, Referrer-Policy. Static
  // assets bypass Worker code — the SPA shell is covered by public/_headers.
  app.use("*", securityHeaders());

  // Per-request correlation id (PRD §38: correlation/request IDs).
  app.use("*", async (c, next) => {
    const requestId = c.req.header("X-Request-Id") ?? newId("req");
    c.set("requestId", requestId);
    c.set("actorEmail", null);
    c.header("X-Request-Id", requestId);
    await next();
    logEvent("http.request", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      outcome: c.res.status < 400 ? "ok" : "error",
    });
  });

  // Public, deliberately anonymous route (PRD §8.2, §19) — the ONE route
  // outside the Access-protected surface: an external watchdog (issue #31)
  // must be able to hit it with no identity. Real degradation checks (#11).
  app.get("/healthz", async (c) => {
    const health = await evaluateHealth(c.env, nowIso());
    c.header("Cache-Control", "no-store");
    // Strictly the two-field contract: no ids, versions, or timestamps.
    return c.json({ status: health.status }, health.status === "ok" ? 200 : 503);
  });

  // Private API surface — everything below is Access-protected (PRD §24).
  const api = new Hono<AppEnv>();
  api.use("*", requireAccess());
  api.use("*", originCheck());

  api.onError((err, c) => {
    const requestId = c.get("requestId");
    if (err instanceof ApiError) {
      if (err.category === "internal") {
        logEvent("api.internal_error", { requestId, path: c.req.path, outcome: "error" });
      }
      return c.json(errorEnvelope(err, requestId), err.status as 400);
    }
    // Unknown errors are logged for operators but never leaked to clients.
    logEvent("api.unhandled_error", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    const internal = ApiError.internal();
    return c.json(errorEnvelope(internal, requestId), internal.status as 400);
  });

  api.route("/clients", clientsRoutes);
  api.route("/notification-targets", notificationTargetsRoutes);
  api.route("/maintenance", maintenanceRoutes);
  api.route("/incidents", incidentsRoutes);
  api.route("/dashboard", dashboardRoutes);
  api.route("/system", systemRoutes);
  api.route("/dead-letters", deadLettersRoutes);
  api.route("/notification-events", notificationEventsRoutes);
  api.route("/monitors", monitorNotificationTargetsRoutes);
  api.route("/monitors", monitorsRoutes);

  app.route("/api", api);

  // Unmatched routes (including unknown /api paths) get the JSON envelope —
  // must live on the ROOT app: unmatched sub-app paths fall through to it.
  app.notFound((c) => {
    const requestId = c.get("requestId");
    return c.json(errorEnvelope(ApiError.notFound("route not found"), requestId), 404);
  });

  return app;
}

const app = createApp();
export default app;
