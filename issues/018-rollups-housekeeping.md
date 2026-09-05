---
id: 018
title: "Hourly/daily rollups + deterministic housekeeping jobs"
type: afk
status: proposed
risk_level: medium
blocked_by: ["010"]
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
  PRD §17.10 hourly_rollups (monitor_id, hour_start PK; eligible/up/down counts; avg/min/max
  response; EXCLUDE manual and maintenance-excluded). §17.11 daily_rollups same + incident_count +
  downtime_ms. §18: cron minute 05 → previous-hour rollup if not already completed; shortly after
  00:00 UTC → previous-day rollup. Every housekeeping job has a deterministic job ID to prevent
  duplicate execution. §36: rollups exist so long ranges don't scan raw checks.
---

# 018 — Hourly/daily rollups + deterministic housekeeping jobs

## User value

Uptime percentages and response-time trends for 24h–90d stay fast forever, even as raw checks expire.

## Scope

- `rollup.hourly` handler: aggregate previous hour's eligible checks (`source=scheduled`, `maintenance_excluded=0`, `affects_state=1`) per monitor into `hourly_rollups`; idempotent recompute (re-running a slot overwrites/merges deterministically).
- `rollup.daily` handler: same for previous UTC day into `daily_rollups`, plus `incident_count` and `downtime_ms`.
- Wire the 010 housekeeping dispatches to these handlers (minute 05 hourly; post-00:00 UTC daily); deterministic job IDs (e.g. include slot in jobId) so duplicate enqueue can't double-execute (idempotent anyway).
- Heartbeats: `last_hourly_rollup_at` / `last_daily_rollup_at` on success.
- Housekeeping failure must not block monitor scheduling (already true via 010; keep true).

## Out of scope

- Retention deletion (019), uptime query API (020), dashboards (022/024).

## Acceptance criteria

- [ ] Deterministic fixture checks roll up into correct hourly/daily counts and response-time min/avg/max (PRD §32.1: rollup and raw periods agree for deterministic fixtures).
- [ ] Manual and maintenance-excluded checks never appear in rollups.
- [ ] Re-delivered/re-enqueued rollup job for the same slot produces identical rows (no double counting) — duplicate-job test.
- [ ] `incident_count` and `downtime_ms` correct for a fixture outage.
- [ ] Heartbeat timestamps update; scheduling of monitor checks unaffected by rollup failures.

## Implementation notes

- Slot keys in UTC; day boundaries 00:00 UTC (PRD §15.1 cron is UTC).

## TDD notes

- Fixture-based: build known checks/incidents, run handler, assert exact rollup rows; run twice, assert unchanged.

## Decision gates

None expected.

## Blocked by

- 010 (housekeeping dispatch + queue infra).
