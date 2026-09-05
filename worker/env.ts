/**
 * Cloudflare Worker bindings for Morabeza CF Uptime.
 *
 * Production bindings (CHECK_QUEUE, EMAIL) and non-secret vars are added in
 * later slices — issues #8, #17, #28 — per PRD-SPEC.md §6 and §31.
 */
export interface Env {
  /** D1 database `morabeza-cf-uptime-db` (issue #3). Local dev uses wrangler's local SQLite. */
  DB: D1Database;
}
