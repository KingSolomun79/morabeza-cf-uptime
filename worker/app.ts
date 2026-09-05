import { Hono } from "hono";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

// Stub health endpoint (issue #1). Real degradation logic lands in issue #11.
app.get("/healthz", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ status: "ok" });
});

export default app;
