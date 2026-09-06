import { describe, expect, it } from "vitest";
import app from "../../worker/app";
import { CONTENT_SECURITY_POLICY } from "../../worker/lib/security-headers";

// public/_headers read through the same Vite ?raw pipeline as the migration
// files (tests/helpers/d1.ts) — no node:fs needed. Vite's import-glob needs
// a pattern, hence the trailing *.
const headersFiles = import.meta.glob("../../public/_headers*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const headerFileEntries = Object.entries(headersFiles);
const rawHeadersFile = headerFileEntries[0]?.[1] ?? "";

/** Minimal parser for the `_headers` block format: `path` then `Name: value`. */
function parseHeadersFile(content: string): Array<{ path: string; headers: Record<string, string> }> {
  const rules: Array<{ path: string; headers: Record<string, string> }> = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ path: trimmed, headers: {} });
      continue;
    }
    const current = rules.at(-1);
    if (!current) throw new Error(`header line before any path: ${line}`);
    const separator = trimmed.indexOf(":");
    if (separator === -1) throw new Error(`malformed header line: ${line}`);
    current.headers[trimmed.slice(0, separator).trim().toLowerCase()] = trimmed
      .slice(separator + 1)
      .trim();
  }
  return rules;
}

// Mirrors app.test.ts: a locked env whose D1 is unreachable → /healthz degrades.
const lockedEnv = {
  DB: {
    prepare: () => {
      throw new Error("d1 unavailable");
    },
  } as unknown as D1Database,
  APP_ACCESS_MODE: "locked",
  APP_ORIGIN: "http://localhost:5173",
} as Parameters<typeof app.request>[2];

describe("Worker security headers (issue #28; PRD §29.11–14)", () => {
  it.each([
    ["/healthz", 503],
    ["/nope", 404],
    ["/api/monitors", 401],
  ])("are present on worker-generated responses: %s (exact status %i)", async (path, expectedStatus) => {
    const res = await app.request(path, { method: "GET" }, lockedEnv);

    // Exact status pins the response PATH being tested — a drifted or 404'd
    // route must fail here, not silently satisfy a >= 400 assertion.
    expect(res.status).toBe(expectedStatus);
    expect(res.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("ships a strict CSP: frame-ancestors 'none' (§29.14), self-only sources, no unsafe directives", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("style-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(CONTENT_SECURITY_POLICY).not.toContain("*");
  });
});

describe("public/_headers (static assets never run Worker code)", () => {
  it("exists (exactly one) and defines exactly one /* rule", () => {
    expect(headerFileEntries).toHaveLength(1);
    expect(rawHeadersFile.length).toBeGreaterThan(0);
    const rules = parseHeadersFile(rawHeadersFile);
    expect(rules).toEqual([{ path: "/*", headers: expect.any(Object) }]);
  });

  it("carries the SAME §29.11–14 directives as the Worker middleware", () => {
    const { headers } = parseHeadersFile(rawHeadersFile)[0];

    // Exact equality is the lockstep guarantee: one policy, two delivery paths.
    expect(headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  });
});
