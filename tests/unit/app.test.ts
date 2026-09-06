import { describe, expect, it } from "vitest";
import app from "../../worker/app";

describe("GET /healthz (wired to #11 degradation checks)", () => {
  const lockedEnv = {
    DB: {
      prepare: () => {
        throw new Error("d1 unavailable");
      },
    } as unknown as D1Database,
    APP_ACCESS_MODE: "locked",
    APP_ORIGIN: "http://localhost:5173",
  } as Parameters<typeof app.request>[2];

  it("degrades honestly when D1 is unreachable (real logic, not the #1 stub)", async () => {
    const res = await app.request("/healthz", { method: "GET" }, lockedEnv);

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "degraded" });
  });

  it("does not leak extra keys in the payload", async () => {
    const res = await app.request("/healthz", { method: "GET" }, lockedEnv);
    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body)).toEqual(["status"]);
  });
});

describe("unknown routes", () => {
  it("return 404", async () => {
    const res = await app.request("/nope");

    expect(res.status).toBe(404);
  });
});
