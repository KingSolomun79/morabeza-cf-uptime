/**
 * Cloudflare Worker bindings and Hono typing for Morabeza CF Uptime.
 *
 * Production bindings (CHECK_QUEUE, EMAIL) and remaining vars are added in
 * later slices — issues #8, #17, #28 — per PRD-SPEC.md §6 and §31.
 */
export interface Env {
  /** D1 database `morabeza-cf-uptime-db` (issue #3). Local dev uses wrangler's local SQLite. */
  DB: D1Database;

  /** Queue producer binding `morabeza-cf-uptime-checks` (issue #8). */
  CHECK_QUEUE: Queue;

  /**
   * Cloudflare Email Service send binding (issue #17; PRD §9.2). Optional in
   * the type because tests inject a fake sender and production provisioning
   * happens in #29 — a handler that finds it missing at runtime fails loudly
   * (recorded on the event, retried, then DLQ), never silently drops.
   */
  EMAIL?: SendEmail;
  /** Configurable FROM address for notification emails (PRD §9.1). */
  DEFAULT_FROM_EMAIL?: string;

  /**
   * Retention windows in days (issue #19; PRD §18) — non-secret wrangler
   * `vars` (strings, as wrangler delivers them). §18 defaults when absent:
   * raw checks 7d, hourly rollups 90d, daily rollups 730d; scheduler_runs is
   * fixed at 7d and not configurable. A present-but-invalid value fails loud
   * in the retention handler (retry → DLQ), never silently misprunes.
   */
  RAW_CHECK_RETENTION_DAYS?: string;
  HOURLY_RETENTION_DAYS?: string;
  DAILY_RETENTION_DAYS?: string;

  /**
   * Public origin of this app; mutating /api requests must send a matching
   * Origin header (PRD §8.4). Local dev: e.g. http://localhost:5173
   */
  APP_ORIGIN: string;
  /**
   * API authentication mode (PRD §8.4, fail-closed):
   * - "locked": reject everything (safe default — misconfiguration cannot open the API)
   * - "local": local development only; trusts X-Dev-Access-Email test identity header
   * - "access": production; requires a verified Cloudflare Access JWT
   */
  APP_ACCESS_MODE: "locked" | "local" | "access";
  /** Cloudflare Access team domain, e.g. morabeza.cloudflareaccess.com (access mode). */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access application AUD tag to pin (recommended; optional). */
  ACCESS_AUDIENCE?: string;
}

/** Hono environment: bindings + per-request variables. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    actorEmail: string | null;
  };
};
