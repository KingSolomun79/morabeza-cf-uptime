/**
 * Security response headers for every Worker-generated response
 * (issue #28; PRD §29.11–14): a strict CSP for the React app, `nosniff`,
 * and a sensible Referrer-Policy, with frame protection expressed through
 * CSP `frame-ancestors` as the PRD specifies.
 *
 * IMPORTANT: static-asset responses (the SPA shell, hashed bundles) are
 * served by the assets layer and NEVER run Worker code, so they cannot get
 * headers from here — those come from `public/_headers`. The unit tests pin
 * the two sources to the exact same directives; change them together.
 *
 * CSP rationale: the production build emits only external module scripts and
 * a stylesheet (no inline), the SPA talks only to its own origin's /api, and
 * charts are inline SVG — so `'self'`-only sources (+ `data:` images) need
 * no exceptions. Local `vite dev` is unaffected (dev server neither applies
 * `_headers` nor injects CSP).
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // §29.14: frame protection through CSP frame-ancestors (not X-Frame-Options).
  "frame-ancestors 'none'",
].join("; ");

/**
 * Applies the §29.11–14 headers to every response this Worker generates:
 * /api/* JSON envelopes, /healthz, and JSON 404s. JSON responses ignore CSP,
 * but setting one policy everywhere keeps the served app consistent and the
 * contract simple to test.
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
  };
}
