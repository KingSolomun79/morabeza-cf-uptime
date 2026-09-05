---
id: 019
title: "Retention cleanup with configurable vars"
type: afk
status: proposed
risk_level: medium
blocked_by: ["010"]
parallel_safe: true
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
  PRD §18 defaults: check_results raw scheduled history 7 days; scheduler_runs 7 days;
  hourly_rollups 90 days; daily_rollups 730 days; incidents retain; maintenance_windows retain;
  notification_events ≥365 days; audit_events ≥365 days; dead_letter_events retain until
  resolved + policy. Retention durations configurable as non-secret production vars
  (RAW_CHECK_RETENTION_DAYS=7, HOURLY_RETENTION_DAYS=90, DAILY_RETENTION_DAYS=730). Once per UTC
  day from the existing cron; deterministic job ID. §42.17: never hard-delete operational history
  (monitors/incidents) in normal flows — cleanup targets raw/rollup/scheduler tables only.
---

# 019 — Retention cleanup with configurable vars

## User value

The database stays small and fast (144k checks/day at scale) without anyone babysitting it, while incidents/audit history is preserved.

## Scope

- `retention.cleanup` queue handler: delete expired rows — `check_results` older than RAW_CHECK_RETENTION_DAYS; `scheduler_runs` > 7d; `hourly_rollups` > HOURLY_RETENTION_DAYS; `daily_rollups` > DAILY_RETENTION_DAYS — per PRD §18 defaults, batched deletes (D1-friendly chunking).
- Never touches: monitors, incidents, maintenance_windows, notification_events, audit_events (retain per §18), `dead_letter_events` (only unresolved retained; resolved rows may follow the operational policy — document choice).
- Vars read from wrangler `vars` (non-secret), with sane fallbacks to §18 defaults.
- Wired to 010's once-per-UTC-day dispatch; deterministic job ID (UTC date in jobId); idempotent.
- `last_cleanup_at` heartbeat; structured log of deletion counts.

## Out of scope

- Rollup computation (018), any monitor/incident deletion.

## Acceptance criteria

- [ ] Fixture data across the retention boundaries is pruned exactly per configured windows; newer data untouched.
- [ ] Incidents, maintenance windows, notification + audit events survive cleanup entirely.
- [ ] Job re-delivery for the same day deletes nothing twice / harmless (deterministic id + idempotent deletes).
- [ ] Deletion runs in bounded batches (no unbounded single statement over huge ranges).
- [ ] `last_cleanup_at` + structured summary log written.

## Implementation notes

- Careful with `check_results`: manual + maintenance rows share the table — retention applies to the raw table wholesale per PRD §18 ("check_results raw scheduled history"), implementer to follow the spec wording: prune by age.

## TDD notes

- Boundary tests (just-inside / just-outside each window), vars override behavior, batch-size unit test.

## Decision gates

Stop and write `DECISION_NEEDED.md` if a different reading of §18 for manual/maintenance rows materially changes the deletion predicate.

## Blocked by

- 010 (dispatch).
