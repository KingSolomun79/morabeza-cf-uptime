/**
 * Issue #4 — Access identity handling (PRD §8.4):
 * - JWT verification (RS256 via WebCrypto against a JWKS endpoint)
 * - auth mode matrix (locked / local / access), fail-closed
 * - origin check for mutating requests
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { ApiError } from "../../worker/lib/errors";
import { originCheck, requireAccess, verifyAccessJwt } from "../../worker/lib/access";
import type { AppEnv, Env } from "../../worker/env";

// ---------------------------------------------------------------------------
// JWT test doubles

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonToBase64Url(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey & { kid: string };

async function getKeyMaterial(): Promise<{
  keyPair: CryptoKeyPair;
  publicJwk: JsonWebKey & { kid: string };
}> {
  if (!keyPair) {
    keyPair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & { kid: string };
    publicJwk.kid = "test-key";
    publicJwk.alg = "RS256";
  }
  return { keyPair, publicJwk };
}

async function signJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: "test-key", typ: "JWT" },
): Promise<string> {
  const { keyPair: keys } = await getKeyMaterial();
  const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function jwksFetch(): typeof fetch {
  return (async () => {
    const { publicJwk: jwk } = await getKeyMaterial();
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }) as typeof fetch;
}

const VERIFY_OPTIONS = {
  teamDomain: "morabeza.cloudflareaccess.com",
  audience: "aud-tag.app",
  fetchImpl: jwksFetch(),
  nowMs: 1_800_000_000_000, // fixed clock
};

describe("verifyAccessJwt", () => {
  it("accepts a valid RS256 token with matching audience and email", async () => {
    const token = await signJwt({
      email: "owner@morabeza.digital",
      aud: "aud-tag.app",
      exp: 1_800_000_100, // after nowMs/1000
    });

    const claims = await verifyAccessJwt(token, VERIFY_OPTIONS);

    expect(claims.email).toBe("owner@morabeza.digital");
    expect(claims.audience).toBe("aud-tag.app");
  });

  it("rejects an expired token", async () => {
    const token = await signJwt({ email: "owner@morabeza.digital", aud: "aud-tag.app", exp: 1_000 });

    await expect(verifyAccessJwt(token, VERIFY_OPTIONS)).rejects.toMatchObject({
      category: "authentication_required",
    });
  });

  it("rejects an audience mismatch", async () => {
    const token = await signJwt({ email: "owner@morabeza.digital", aud: "someone-elses-app", exp: 1_800_000_100 });

    await expect(verifyAccessJwt(token, VERIFY_OPTIONS)).rejects.toMatchObject({
      category: "authentication_required",
    });
  });

  it("rejects a tampered payload (bad signature)", async () => {
    const token = await signJwt({ email: "attacker@evil.example", aud: "aud-tag.app", exp: 1_800_000_100 });
    const [head, , sig] = token.split(".");
    const forgedPayload = jsonToBase64Url({ email: "owner@morabeza.digital", aud: "aud-tag.app", exp: 1_800_000_100 });
    const forged = `${head}.${forgedPayload}.${sig}`;

    await expect(verifyAccessJwt(forged, VERIFY_OPTIONS)).rejects.toMatchObject({
      category: "authentication_required",
    });
  });

  it("rejects tokens without an email claim or with an unexpected algorithm", async () => {
    const noEmail = await signJwt({ aud: "aud-tag.app", exp: 1_800_000_100 });
    await expect(verifyAccessJwt(noEmail, VERIFY_OPTIONS)).rejects.toMatchObject({
      category: "authentication_required",
    });

    const wrongAlg = await signJwt({ email: "owner@morabeza.digital", aud: "aud-tag.app", exp: 1_800_000_100 }, {
      alg: "HS256",
      kid: "test-key",
    });
    await expect(verifyAccessJwt(wrongAlg, VERIFY_OPTIONS)).rejects.toMatchObject({
      category: "authentication_required",
    });
  });
});

// ---------------------------------------------------------------------------
// Middleware mode matrix

function appWith(): Hono<AppEnv> {
  const testApp = new Hono<AppEnv>();
  // Inject the JWKS fetch so access-mode tests never touch the network.
  testApp.use("*", requireAccess({ fetchImpl: jwksFetch() }));
  testApp.use("*", originCheck());
  testApp.post("/echo", (c) => c.json({ actor: c.get("actorEmail") }));
  testApp.all("/*", (c) => c.json({ ok: true }));
  // Mirror the real app shell: ApiError → its HTTP status.
  testApp.onError((err, c) => {
    const status = err instanceof ApiError ? err.status : 500;
    return c.json({ error: { category: err instanceof ApiError ? err.category : "internal" } }, status as 400);
  });
  return testApp;
}

function baseEnv(): Env {
  return {
    DB: {} as D1Database,
    APP_ACCESS_MODE: "local",
    APP_ORIGIN: "http://localhost:5173",
  } as Env;
}

const LOCAL_ORIGIN_HEADERS = { Origin: "http://localhost:5173" };

describe("requireAccess modes (fail-closed)", () => {
  it("locked mode rejects everything with authentication_required", async () => {
    const res = await appWith().request("/echo", { method: "POST" }, {
      ...baseEnv(),
      APP_ACCESS_MODE: "locked",
    } as Env);

    expect(res.status).toBe(401);
  });

  it("local mode uses the test-identity header, with a local fallback", async () => {
    const custom = await appWith().request(
      "/echo",
      { method: "POST", headers: { "X-Dev-Access-Email": "tester@morabeza.digital", ...LOCAL_ORIGIN_HEADERS } },
      baseEnv(),
    );
    expect(((await custom.json()) as { actor: string }).actor).toBe("tester@morabeza.digital");

    const fallback = await appWith().request("/echo", { method: "POST", headers: LOCAL_ORIGIN_HEADERS }, baseEnv());
    expect(((await fallback.json()) as { actor: string }).actor).toBe("dev@morabeza.local");
  });

  it("access mode without a token is rejected", async () => {
    const res = await appWith().request("/echo", { method: "POST" }, {
      ...baseEnv(),
      APP_ACCESS_MODE: "access",
      ACCESS_TEAM_DOMAIN: "morabeza.cloudflareaccess.com",
    } as Env);

    expect(res.status).toBe(401);
  });

  it("access mode accepts a verified Access JWT as the audit actor", async () => {
    const token = await signJwt({
      email: "owner@morabeza.digital",
      aud: "aud-tag.app",
      exp: 1_800_000_100,
    });
    const res = await appWith().request(
      "/echo",
      { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, ...LOCAL_ORIGIN_HEADERS } },
      {
        ...baseEnv(),
        APP_ACCESS_MODE: "access",
        ACCESS_TEAM_DOMAIN: "morabeza.cloudflareaccess.com",
        ACCESS_AUDIENCE: "aud-tag.app",
      } as Env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { actor: string }).actor).toBe("owner@morabeza.digital");
  });
});

describe("origin check for mutations (PRD §8.4)", () => {
  it("accepts the configured origin", async () => {
    const res = await appWith().request(
      "/echo",
      { method: "POST", headers: { Origin: "http://localhost:5173" } },
      baseEnv(),
    );
    expect(res.status).toBe(200);
  });

  it("rejects foreign origins", async () => {
    const res = await appWith().request(
      "/echo",
      { method: "POST", headers: { Origin: "https://evil.example.com" } },
      baseEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("rejects mutations without any Origin header", async () => {
    const res = await appWith().request("/echo", { method: "DELETE" }, baseEnv());
    expect(res.status).toBe(403);
  });

  it("localhost origins are NOT allowed in production (access) mode", async () => {
    const token = await signJwt({
      email: "owner@morabeza.digital",
      aud: "aud-tag.app",
      exp: 1_800_000_100,
    });
    const res = await appWith().request(
      "/echo",
      { method: "POST", headers: { Origin: "http://localhost:5173", "Cf-Access-Jwt-Assertion": token } },
      {
        ...baseEnv(),
        APP_ACCESS_MODE: "access",
        APP_ORIGIN: "https://uptime.morabeza.digital",
        ACCESS_TEAM_DOMAIN: "morabeza.cloudflareaccess.com",
        ACCESS_AUDIENCE: "aud-tag.app",
      } as Env,
    );

    // Passes auth (verified JWT) but the origin check must stop the mutation.
    expect(res.status).toBe(403);
  });
});
