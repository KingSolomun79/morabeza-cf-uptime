/**
 * Cloudflare Access identity handling for the private API (PRD §8.4).
 *
 * Fail-closed by design: the API is open ONLY in one of three explicit modes
 * (Env.APP_ACCESS_MODE):
 * - "locked": reject everything (default; a misconfiguration cannot expose the API)
 * - "local":  local development; trusts the X-Dev-Access-Email test-identity
 *             header. This branch is unreachable in production as long as the
 *             deployed var is not "local" (#28 owns the production vars).
 * - "access": production; requires a signature-verified Cloudflare Access JWT
 *             (Cf-Access-Jwt-Assertion header). A client-supplied email is
 *             NEVER trusted as the audit actor (PRD §8.4).
 */
import { ApiError } from "./errors";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const DEV_IDENTITY_HEADER = "X-Dev-Access-Email";
const LOCAL_FALLBACK_IDENTITY = "dev@morabeza.local";

export interface AccessClaims {
  email: string;
  audience: string | null;
  expiresAtMs: number;
}

export interface VerifyAccessJwtOptions {
  teamDomain: string;
  audience?: string | null;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  email?: string;
  exp?: number;
  aud?: string | string[];
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJsonSegment<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as T;
}

/**
 * Verifies a Cloudflare Access JWT against the team domain's JWKS endpoint
 * (RS256 via WebCrypto), then checks expiry, optional audience pin, and the
 * email claim.
 */
export async function verifyAccessJwt(
  token: string,
  options: VerifyAccessJwtOptions,
): Promise<AccessClaims> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now();

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw ApiError.authenticationRequired("malformed Access token");
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeJsonSegment<JwtHeader>(headerSegment);
  if (header.alg !== "RS256" || !header.kid) {
    throw ApiError.authenticationRequired("unsupported Access token header");
  }

  const jwksResponse = await fetchImpl(`https://${options.teamDomain}/cdn-cgi/access/certs`);
  if (!jwksResponse.ok) {
    throw new ApiError("upstream_failure", "could not load Access public keys");
  }
  const jwks = (await jwksResponse.json()) as { keys?: Array<Record<string, unknown> & { kid?: string }> };
  const jwk = jwks.keys?.find((candidate) => candidate.kid === header.kid);
  if (!jwk) {
    throw ApiError.authenticationRequired("Access signing key not recognized");
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk as unknown as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const encoder = new TextEncoder();
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(signatureSegment),
    encoder.encode(`${headerSegment}.${payloadSegment}`),
  );
  if (!valid) {
    throw ApiError.authenticationRequired("Access token signature is invalid");
  }

  const payload = decodeJsonSegment<JwtPayload>(payloadSegment);
  if (!payload.exp || payload.exp * 1000 <= nowMs) {
    throw ApiError.authenticationRequired("Access token is expired");
  }
  const audiences = payload.aud
    ? (Array.isArray(payload.aud) ? payload.aud : [payload.aud])
    : [];
  if (options.audience && !audiences.includes(options.audience)) {
    throw ApiError.authenticationRequired("Access token audience mismatch");
  }
  if (!payload.email) {
    throw ApiError.authenticationRequired("Access token carries no email claim");
  }

  return { email: payload.email, audience: audiences[0] ?? null, expiresAtMs: payload.exp * 1000 };
}

function isLocalOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Rejects mutating requests whose Origin does not match APP_ORIGIN
 * (PRD §8.4). Local mode additionally accepts localhost origins so the dev
 * UI can call the API.
 */
export function originCheck(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    const method = c.req.method.toUpperCase();
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
      const origin = c.req.header("Origin");
      const allowed =
        origin === c.env.APP_ORIGIN || (c.env.APP_ACCESS_MODE === "local" && isLocalOrigin(origin ?? null));
      if (!origin || !allowed) {
        throw ApiError.forbidden("origin not allowed for mutations");
      }
    }
    await next();
  };
}

/**
 * API authentication gate (PRD §8.4). Sets actorEmail for handlers/audit.
 * See the module doc comment for the mode contract.
 */
export function requireAccess(options: { fetchImpl?: typeof fetch } = {}): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    const mode = c.env.APP_ACCESS_MODE ?? "locked";
    let email: string | undefined;

    if (mode === "access") {
      const token = c.req.header(ACCESS_JWT_HEADER);
      if (!token) {
        throw ApiError.authenticationRequired("missing Cloudflare Access identity");
      }
      if (!c.env.ACCESS_TEAM_DOMAIN) {
        // Fail closed: access mode without a team domain is a misconfiguration.
        throw new ApiError("internal", "Access is not configured");
      }
      const claims = await verifyAccessJwt(token, {
        teamDomain: c.env.ACCESS_TEAM_DOMAIN,
        audience: c.env.ACCESS_AUDIENCE ?? null,
        fetchImpl: options.fetchImpl,
      });
      email = claims.email;
    } else if (mode === "local") {
      email = c.req.header(DEV_IDENTITY_HEADER) ?? LOCAL_FALLBACK_IDENTITY;
    } else {
      throw ApiError.authenticationRequired("API is locked");
    }

    c.set("actorEmail", email);
    await next();
  };
}
