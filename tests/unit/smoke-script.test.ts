import { describe, expect, it } from "vitest";
import {
  MANUAL_CHECKS,
  automatedPassed,
  isAccessBlocked,
  missingSecurityHeaders,
  normalizeBaseUrl,
  runSmokeChecks,
} from "../../scripts/smoke.mjs";

/** Fixture fetch: routes recorded GETs to canned responses. */
interface FixtureRoute {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function fixtureFetch(routes: Record<string, FixtureRoute>) {
  const calls: Array<{ url: string; redirect: unknown }> = [];
  const impl = (input: unknown, init?: { redirect?: string }) => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect });
    const route = routes[url];
    if (!route) throw new Error(`unexpected smoke call: ${url}`);
    const body = route.body === undefined ? null : typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(body, { status: route.status, headers: route.headers ?? {} });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** Strict-null-safe lookup: a missing check id fails the test loudly. */
function checkById(result: Awaited<ReturnType<typeof runSmokeChecks>>, id: string) {
  const found = result.checks.find((c) => c.id === id);
  if (!found) throw new Error(`missing check: ${id}`);
  return found;
}

function allGreenRoutes(): Record<string, FixtureRoute> {
  return {
    "https://uptime.example/healthz": { status: 200, body: { status: "ok" }, headers: SECURITY_HEADERS },
    "https://uptime.example/": {
      status: 302,
      body: "",
      headers: { location: "https://morabeza.cloudflareaccess.com/cdn-cgi/access/login/uptime.example" },
    },
    "https://uptime.example/api/monitors": { status: 401, body: { error: { category: "authentication_required" } } },
  };
}

describe("smoke script (issue #28; PRD §32.3 automatable subset)", () => {
  it("passes all four automated checks against a healthy, Access-gated deployment", async () => {
    const { impl, calls } = fixtureFetch(allGreenRoutes());

    const result = await runSmokeChecks("https://uptime.example/", { fetchImpl: impl });

    expect(result.baseUrl).toBe("https://uptime.example");
    expect(result.checks.map((c: { id: string }) => c.id)).toEqual([
      "healthz",
      "worker-security-headers",
      "anonymous-root",
      "anonymous-api",
    ]);
    expect(automatedPassed(result)).toBe(true);
    // Read-only probes: GET only, redirects observed not followed (Access 302s).
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("fails healthz when it reports degraded (503)", async () => {
    const routes = allGreenRoutes();
    routes["https://uptime.example/healthz"] = {
      status: 503,
      body: { status: "degraded" },
      headers: SECURITY_HEADERS,
    };
    const { impl } = fixtureFetch(routes);

    const result = await runSmokeChecks("https://uptime.example", { fetchImpl: impl });
    const healthz = checkById(result, "healthz");

    expect(healthz.status).toBe("fail");
    expect(healthz.detail).toContain("degraded");
    expect(automatedPassed(result)).toBe(false);
  });

  it("enforces the STRICT two-field healthz contract — extra keys fail", async () => {
    const routes = allGreenRoutes();
    routes["https://uptime.example/healthz"] = {
      status: 200,
      body: { status: "ok", version: "0.1.0" },
      headers: SECURITY_HEADERS,
    };
    const { impl } = fixtureFetch(routes);

    const result = await runSmokeChecks("https://uptime.example", { fetchImpl: impl });

    expect(checkById(result, "healthz").status).toBe("fail");
  });

  it("fails healthz on a non-JSON body", async () => {
    const routes = allGreenRoutes();
    routes["https://uptime.example/healthz"] = { status: 200, body: "<html>up</html>" };
    const { impl } = fixtureFetch(routes);

    const result = await runSmokeChecks("https://uptime.example", { fetchImpl: impl });

    const healthz = checkById(result, "healthz");
    expect(healthz.status).toBe("fail");
    expect(healthz.detail).toContain("non-JSON");
  });

  it("fails when an anonymous request reaches the SPA or the API", async () => {
    const open = allGreenRoutes();
    open["https://uptime.example/"] = { status: 200, body: "<html>ui</html>" };
    open["https://uptime.example/api/monitors"] = { status: 200, body: { data: [] } };
    const { impl } = fixtureFetch(open);

    const result = await runSmokeChecks("https://uptime.example", { fetchImpl: impl });

    const byId = Object.fromEntries(result.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
    expect(byId["anonymous-root"]).toBe("fail");
    expect(byId["anonymous-api"]).toBe("fail");
    expect(automatedPassed(result)).toBe(false);
  });

  it("treats a 404 on the anonymous API as a failure, not a block", async () => {
    const routes = allGreenRoutes();
    routes["https://uptime.example/api/monitors"] = { status: 404, body: { error: {} } };
    const { impl } = fixtureFetch(routes);

    const result = await runSmokeChecks("https://uptime.example", { fetchImpl: impl });

    expect(checkById(result, "anonymous-api").status).toBe("fail");
  });

  it("fails when the deployed worker is missing §29 security headers", async () => {
    const routes = allGreenRoutes();
    routes["https://uptime.example/healthz"] = { status: 200, body: { status: "ok" } };
    const { impl } = fixtureFetch(routes);

    const result = await runSmokeChecks("https://uptime.example", { fetchImpl: impl });

    const headersCheck = checkById(result, "worker-security-headers");
    expect(headersCheck.status).toBe("fail");
    expect(headersCheck.detail).toContain("content-security-policy");
    expect(headersCheck.detail).toContain("x-content-type-options");
    expect(headersCheck.detail).toContain("referrer-policy");
  });

  it("surfaces connection errors as error (not silent pass)", async () => {
    const failing = (() => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await runSmokeChecks("https://uptime.example", { fetchImpl: failing });

    expect(automatedPassed(result)).toBe(false);
    expect(result.checks.every((c: { status: string }) => c.status === "error")).toBe(true);
  });

  it("rejects non-http(s) bases and normalizes trailing slashes", () => {
    expect(normalizeBaseUrl("https://uptime.example/")).toBe("https://uptime.example");
    expect(() => normalizeBaseUrl("ftp://uptime.example")).toThrow(/http\(s\)/);
    expect(() => normalizeBaseUrl("not a url")).toThrow(/not a valid URL/);
  });

  it("classifies Access blocks and plain failures correctly", () => {
    for (const status of [301, 302, 303, 307, 308, 401, 403]) {
      expect(isAccessBlocked(status)).toBe(true);
    }
    for (const status of [200, 400, 404, 500, 503]) {
      expect(isAccessBlocked(status)).toBe(false);
    }
  });

  it("flags missing/invalid security headers by name", () => {
    expect(missingSecurityHeaders(new Headers(SECURITY_HEADERS))).toEqual([]);
    expect(missingSecurityHeaders(new Headers({ "referrer-policy": "no-referrer" }))).toEqual([
      "content-security-policy",
      "x-content-type-options",
    ]);
    // A CSP without frame-ancestors 'none' does not count (§29.14) — isolate
    // that requirement by keeping the other two headers present.
    expect(
      missingSecurityHeaders(
        new Headers({ ...SECURITY_HEADERS, "content-security-policy": "default-src 'self'" }),
      ),
    ).toEqual(["content-security-policy"]);
  });

  it("enumerates exactly the twelve manual §32.3 items (#3, #5–#15)", () => {
    expect(MANUAL_CHECKS.map((m: { id: string }) => m.id)).toEqual([
      "#3",
      "#5",
      "#6",
      "#7",
      "#8",
      "#9",
      "#10",
      "#11",
      "#12",
      "#13",
      "#14",
      "#15",
    ]);
    expect(MANUAL_CHECKS.every((m: { how: string }) => m.how.length > 0)).toBe(true);
  });
});
