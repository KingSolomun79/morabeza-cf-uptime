# ADR 0003 — Cron schedules, Queue executes monitor checks

- **Status:** Accepted
- **Date:** 2026-09-05
- **Governing spec:** `docs/PRD-SPEC.md` §4 (decisions 4, 5, 6, 7), §15, §16, §37

## Context

Monitors need different intervals (60/120/300/600 seconds) without multiple Cron
Triggers, and the system must scale to hundreds of monitors without performing
all checks inside one Cron invocation. Cloudflare Queues provides at-least-once
delivery, so any consumer design must tolerate duplicate delivery.

## Decision

The single Cron Trigger fires once per minute (UTC). Its handler stays
lightweight and never performs target HTTP requests. Each run it:

1. normalizes the fire time to a minute slot;
2. updates the scheduler heartbeat;
3. selects active monitors where `next_check_at <= now`;
4. enqueues deterministic, idempotently-keyed messages (e.g. `checkId = "{monitorId}:{scheduledFor}"`) in batches;
5. advances `next_check_at` only for work successfully queued;
6. records a run summary and dispatches housekeeping jobs (rollups, retention, heartbeats) from the same trigger.

A Queue consumer executes each check: it reloads monitor configuration from D1
(never trusting the payload), performs the HTTP check, and persists the result
keyed by the deterministic check id. Duplicate delivery is neutralized by that
unique key: an already-present result means "already completed", so state side
effects are never repeated. Out-of-order delivery cannot roll monitor state
backwards (`last_evaluated_scheduled_for` + `state_version` compare-and-set).
Exhausted messages route to a dead-letter Queue, whose consumer records
`dead_letter_events` for operator visibility.

## Consequences

- One Cron serves all intervals; scaling adds Queue consumers, not triggers (PRD §36).
- Every handler must be idempotent — this is a standing correctness requirement, tested per slice (PRD §37).
- Housekeeping failures must never block monitor scheduling (PRD §37.8).
- Missed minutes are not backfilled: one current check, then the next future slot (PRD §15.3).

## Alternatives considered

- **One Cron per interval.** Rejected by PRD §10.3 — trigger sprawl and duplicated scheduling logic.
- **Checking all monitors inside the Cron handler.** Rejected: CPU/duration limits, no retry isolation, one slow target delays the whole fleet.
- **Backfilling missed checks after downtime.** Rejected: history distortion and thundering-herd recovery; the spec prefers a single fresh check.

## References

- PRD-SPEC.md §10.3, §15, §16, §18, §36, §37
- ADR 0002 (single Worker hosts both the Cron producer and Queue consumer)
