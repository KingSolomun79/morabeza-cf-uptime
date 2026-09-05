/**
 * Worker application shell (PRD §24, §30): public /healthz + the private
 * /api surface behind the middleware chain (request id → Access auth →
 * origin check), consistent error envelopes (PRD §38), and structured
 * request logging (PRD §28).
 */
import { Hono } from "hono";
import { logEvent } from "./lib/logging";
import { errorEnvelope, ApiError } from "./lib/errors";
import { originCheck, requireAccess } from "./lib/access";
import { newId } from "./lib/ids";
import { clientsRoutes } from "./routes/clients";
import { monitorsRoutes } from "./routes/monitors";
import { maintenanceRoutes } from "./routes/maintenance";
import { monitorNotificationTargetsRoutes, notificationTargetsRoutes } from "./routes/notifications";
import type { AppEnv } from "./env";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

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

  // Public, deliberately anonymous route (PRD §8.2, §19). Real degradation
  // logic lands in issue #11.
  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ status: "ok" });
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
