import { describe, expect, it } from "vitest";
import app from "../../worker/app";

describe("GET /healthz (stub, issue #1)", () => {
  it("returns 200 with the minimal ok payload", async () => {
    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("does not leak extra keys in the payload", async () => {
    const res = await app.request("/healthz");
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
