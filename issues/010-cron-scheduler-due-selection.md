---
id: 010
title: "Cron scheduler: minute slots, due selection, deterministic IDs, batching, housekeeping dispatch"
type: afk
status: proposed
risk_level: high
blocked_by: ["005", "008"]
parallel_safe: false
executor: pi_tdd
requires_tests: true
requires_review: true
requires_qa: true
requires_cso: true
requires_human_approval: false
decision_gate_required: false
context_files_to_load:
  - docs/PRD-SPEC.md
embedded_context: |
  PRD §15: exactly one Cron Trigger "* * * * *" (UTC). Handler must stay lightweight: normalize
  to minute slot; update scheduler heartbeat; query active monitors where next_check_at <= now;
  create deterministic Queue messages (checkId = "{monitorId}:{scheduledFor}"); enqueue in
  batches; advance next_check_at ONLY for successfully queued work; record scheduler_runs
  summary; occasionally enqueue housekeeping jobs by UTC time; NEVER perform target HTTP requests.
  §15.3 missed schedule: no backfill — one current check, next check scheduled in the future.
  §18 housekeeping from the same Cron: minute 05 → previous-hour rollup; shortly after 00:00 UTC
  → previous-day rollup; once per UTC day → retention cleanup; every 5 min → system Queue
  heartbeat. Every housekeeping job has a deterministic job ID.
---

# 010 — Cron scheduler: minute slots, due selection, deterministic IDs, batching, housekeeping dispatch

## User value

One cron drives all intervals: monitors get checked on schedule without duplicate work, and missed minutes never snowball into backfill storms.

## Scope

- `scheduled` handler (PRD §15.2 steps 1–9): minute-slot normalization; `system_state.last_scheduler_at` heartbeat; due-monitor query `(enabled=1, archived_at IS NULL, next_check_at <= slot)` using the `enabled + next_check_at` index; batched enqueue of deterministic `monitor.check` messages (`checkId = monitorId:scheduledFor`, `affects_state: true`); advance `next_check_at` only for successfully enqueued work; `scheduler_runs` summary row (due count, enqueued count, failed batches, duration).
- Missed-schedule behavior: overdue monitor → one current check, next `next_check_at` in the future per interval (no historical backfill).
- Housekeeping dispatch (envelopes only; handlers arrive in 017/018/019): hourly rollup at minute 05, daily rollup after 00:00 UTC, daily retention cleanup, 5-minute `system.heartbeat` — all with deterministic job IDs.
- Housekeeping failure must not block monitor scheduling (PRD §37.8).
- Cron config `* * * * *` in wrangler (local invocation via test hook from 007).

## Out of scope

- Executing checks (009), rollup/cleanup/heartbeat handler bodies (018/019), notification sends (017).

## Acceptance criteria

- [ ] Monitors with intervals 60/120/300/600 all get checked on their cadence from the single cron (simulated minute ticks in tests).
- [ ] `checkId` deterministic per (monitor, slot): two scheduler runs for the same slot enqueue the same job id; consumer-side idempotency (009) prevents double effects.
- [ ] Enqueue failure for a batch leaves those monitors due (`next_check_at` unchanged) — retried next pass (PRD §37.7).
- [ ] Overdue monitor produces exactly one current check, no backfill.
- [ ] `scheduler_runs` + `last_scheduler_at` written every run; scheduled handler performs zero outbound HTTP fetches (assert in tests).
- [ ] Housekeeping messages emitted at the right slots with deterministic job IDs; a housekeeping enqueue error does not skip monitor scheduling.

## Implementation notes

- Batch size bounded (PRD §36: paginate due monitors, enqueue in batches — design for hundreds of monitors, not a fixed small count).

## TDD notes

- Drive the handler with synthetic UTC times across minute boundaries, DST-irrelevant UTC, overdue cases, and enqueue-failure injection.

## Decision gates

Stop and write `DECISION_NEEDED.md` if Queue batch limits require a pagination strategy that changes the `next_check_at` advancement contract.

## Blocked by

- 005 (monitors + next_check_at), 008 (queue producer/consumer infra).
