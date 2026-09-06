/**
 * Issue #4 — API shell + Clients CRUD tests, run against REAL D1 emulation
 * (miniflare/workerd) with the committed migrations applied.
 *
 * Covers PRD §24 clients surface, §38 error envelopes, §8.4 auth/origin/JSON
 * rules, and §17.14 audit rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import app from "../../worker/app";
import type { Env } from "../../worker/env";

const migrationFiles = import.meta.glob("../../db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const LOCAL_ORIGIN = "http://localhost:5173";

let mf: Miniflare;
let d1: D1Database;

const baseEnv: Omit<Env, "DB"> = {
  APP_ACCESS_MODE: "local",
  APP_ORIGIN: LOCAL_ORIGIN,
  CHECK_QUEUE: {
    send: async () => undefined,
    sendBatch: async () => undefined,
  } as unknown as Queue,
};

function env(overrides: Partial<Env> = {}): Env {
  return { DB: d1, ...baseEnv, ...overrides } as Env;
}

async function request(path: string, init: RequestInit = {}, envOverrides: Partial<Env> = {}): Promise<Response> {
  return app.request(path, init, env(envOverrides));
}

async function json(
  path: string,
  method: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: LOCAL_ORIGIN,
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null); } }",
    d1Databases: { DB: "appdb" },
  });
  d1 = (await mf.getD1Database("DB")) as D1Database;

  const paths = Object.keys(migrationFiles).sort();
  expect(paths.length).toBe(3); // 0000 init + 0001 guards + 0002 notification test events
  for (const path of paths) {
    for (const statement of migrationFiles[path].split("--> statement-breakpoint")) {
      // D1 exec() splits input on newlines, so each statement must be a
      // single line: drop comment lines and collapse whitespace.
      const lines = statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length === 0) continue;
      await d1.exec(lines.join(" "));
    }
  }
}, 30000);

afterAll(async () => {
  await mf?.dispose();
});

describe("authentication gate (PRD §8.4)", () => {
  it("locked mode rejects /api with an authentication_required envelope", async () => {
    const res = await request("/api/clients", {}, { APP_ACCESS_MODE: "locked" });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { category: string; requestId: string; details: unknown } };
    expect(body.error.category).toBe("authentication_required");
    expect(body.error.requestId).toMatch(/^req_/);
    expect(res.headers.get("X-Request-Id")).toBe(body.error.requestId);
  });

  it("healthz remains public even in locked mode (PRD §8.2)", async () => {
    const res = await request("/healthz", {}, { APP_ACCESS_MODE: "locked" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("local mode authenticates with the injected dev identity by default", async () => {
    const res = await request("/api/clients");

    expect(res.status).toBe(200);
  });
});

describe("clients CRUD (PRD §24)", () => {
  it("lists the seeded Morabeza client and excludes archived rows by default", async () => {
    const res = await request("/api/clients");
    const body = (await res.json()) as { data: Array<{ slug: string; name: string; active: boolean }> };

    expect(res.status).toBe(200);
    expect(body.data.some((client) => client.slug === "morabeza" && client.name === "Morabeza")).toBe(true);
  });

  it("creates a client", async () => {
    const res = await json("/api/clients", "POST", {
      name: "Acme Corp",
      slug: "acme-corp",
      notes: "flagship customer",
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; slug: string; active: boolean; archivedAt: string | null } };
    expect(body.data.id).toMatch(/^cli_/);
    expect(body.data).toMatchObject({ slug: "acme-corp", active: true, archivedAt: null });
  });

  it("rejects duplicate slugs with a conflict envelope", async () => {
    const res = await json("/api/clients", "POST", { name: "Second", slug: "acme-corp" });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { category: string; message: string } };
    expect(body.error.category).toBe("conflict");
    expect(body.error.message).toContain("acme-corp");
  });

  it("rejects invalid payloads with field-level validation details", async () => {
    const res = await json("/api/clients", "POST", { name: "", slug: "Not A Slug" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { category: string; details: Array<{ path: string }> } };
    expect(body.error.category).toBe("validation");
    const paths = body.error.details.map((detail) => detail.path);
    expect(paths).toContain("name");
    expect(paths).toContain("slug");
  });

  it("rejects non-JSON mutation bodies (PRD §8.4)", async () => {
    const res = await request("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: LOCAL_ORIGIN },
      body: "name=Acme",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { category: string } };
    expect(body.error.category).toBe("validation");
  });

  it("returns 404 not_found for unknown ids and unknown routes", async () => {
    const missingClient = await request("/api/clients/cli_does_not_exist");
    expect(missingClient.status).toBe(404);
    expect(((await missingClient.json()) as { error: { category: string } }).error.category).toBe("not_found");

    const missingRoute = await request("/api/nope");
    expect(missingRoute.status).toBe(404);
    expect(((await missingRoute.json()) as { error: { category: string } }).error.category).toBe("not_found");
  });

  it("updates a client (PATCH)", async () => {
    const created = await json("/api/clients", "POST", { name: "Beta LLC", slug: "beta-llc" });
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    const res = await json(`/api/clients/${id}`, "PATCH", { name: "Beta LLC Renamed", active: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string; active: boolean } };
    expect(body.data).toMatchObject({ name: "Beta LLC Renamed", active: false });
  });

  it("archives instead of deleting: preserved via includeArchived, excluded by default", async () => {
    const created = await json("/api/clients", "POST", { name: "Gamma Inc", slug: "gamma-inc" });
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    const deleted = await json(`/api/clients/${id}`, "DELETE");
    expect(deleted.status).toBe(200);
    const archiveBody = (await deleted.json()) as { data: { archivedAt: string | null } };
    expect(archiveBody.data.archivedAt).not.toBeNull();

    const defaultList = (await (await request("/api/clients")).json()) as { data: Array<{ id: string }> };
    expect(defaultList.data.some((client) => client.id === id)).toBe(false);

    const fullList = (await (await request("/api/clients?includeArchived=true")).json()) as {
      data: Array<{ id: string; archivedAt: string | null }>;
    };
    const archived = fullList.data.find((client) => client.id === id);
    expect(archived?.archivedAt).not.toBeNull();
  });

  it("rejects mutations with missing or mismatched Origin (PRD §8.4)", async () => {
    const noOrigin = await request("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X", slug: "x" }),
    });
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { error: { category: string } }).error.category).toBe("forbidden");

    const evilOrigin = await json("/api/clients", "POST", { name: "X", slug: "x" }, {
      Origin: "https://evil.example.com",
    });
    expect(evilOrigin.status).toBe(403);
  });
});

describe("audit trail (PRD §17.14)", () => {
  it("writes an audit row per mutation with the Access-derived actor email", async () => {
    const created = await json("/api/clients", "POST", { name: "Delta Co", slug: "delta-co" });
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    await json(`/api/clients/${id}`, "PATCH", { notes: "updated" });
    await json(`/api/clients/${id}`, "DELETE");

    const result = await d1
      .prepare("SELECT action, actor_email, entity_id FROM audit_events WHERE entity_id = ? ORDER BY created_at")
      .bind(id)
      .all<{ action: string; actor_email: string; entity_id: string }>();

    expect(result.results.map((row) => row.action)).toEqual([
      "client.create",
      "client.update",
      "client.archive",
    ]);
    expect(result.results.every((row) => row.actor_email === "dev@morabeza.local")).toBe(true);
  });
});
