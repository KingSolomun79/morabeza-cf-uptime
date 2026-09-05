# ADR 0002 — Single Worker serves API, UI, Cron, and Queue events

- **Status:** Accepted
- **Date:** 2026-09-05
- **Governing spec:** `docs/PRD-SPEC.md` §4 (confirmed decisions 1, 2, 5, 7, 11)

## Context

The product needs an HTTP API, a private React admin UI, a once-per-minute Cron
scheduler, and Queue consumers. These roles could be split across multiple
Workers, pages projects, or external services.

## Decision

One Cloudflare Worker application (`morabeza-cf-uptime`) handles every runtime
surface:

- `fetch` — Hono API (`/api/*`, `/healthz`) plus the React UI via Workers Static Assets (deployed as one unit with the official Cloudflare Vite plugin);
- `scheduled` — the single production Cron Trigger (`* * * * *`), which only schedules due work;
- `queue` — consumer for the main check Queue (and the DLQ consumer).

There is no second Worker, no separate Pages project, no VPS, container, n8n,
Supabase, Firebase, or external database. Cloudflare Workflows are not used in V1.

## Consequences

- One deploy unit, one config surface (`wrangler.jsonc`), one observability stream — operational simplicity.
- Internal layering (routes / queue handlers / scheduler / services / repositories) keeps concerns separated inside the single codebase (PRD §30).
- All surfaces share one dependency set; a heavy dependency for one surface affects all. Mitigated by PRD §5.1's "prefer Workers-native APIs" and "no `nodejs_compat` unless required" rules.

## Alternatives considered

- **Separate scheduler Worker + API Worker + assets on Pages.** Rejected: three deploy units and three configs for a V1 that fits comfortably in one Worker; more coordination without user-visible benefit.
- **Workflows for check orchestration.** Rejected by PRD §4.11 for V1 — Queues plus the one-minute Cron already cover fan-out with idempotency.

## References

- PRD-SPEC.md §2, §4, §5, §30, §31
- ADR 0003 (Queue-based execution model)
