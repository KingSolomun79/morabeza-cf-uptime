---
id: 014
title: "Manual checks: queue-executed, persisted, zero state/uptime effect"
type: afk
status: proposed
risk_level: low
blocked_by: ["009"]
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
  PRD §13: "Run check now" executes through the Queue with a unique manual check ID; persisted
  for diagnostic visibility; source = manual; does NOT affect uptime percentages; does NOT
  increment failure/recovery counters; does NOT open/close incidents; does NOT trigger
  DOWN/RECOVERED emails. Operators must be able to test a monitor without perturbing production
  statistics.
---

# 014 — Manual checks: queue-executed, persisted, zero state/uptime effect

## User value

Operators can immediately verify a target ("did my deploy fix it?") without waiting for the interval — and without polluting uptime stats or paging anyone.

## Scope

- `POST /api/monitors/:id/check` (PRD §24): validates the monitor exists and is not archived; enqueues a `monitor.check` message with a unique manual check ID, `source: manual`, `affects_state: false`.
- Consumer path honors `source=manual`: result persisted with `source=manual`, `affects_state=0`; state machine, counters, incidents, and notifications all bypassed (via the 012 seams).
- Manual result visible in monitor history (feeds 024's recent-checks table with scheduled/manual column).
- Rate/abuse sanity: bounded so the endpoint can't be spammed into a check flood (simple per-monitor throttle is enough for V1).
- Audit event on invocation.

## Out of scope

- UI button (023/024), uptime exclusion math (020 — eligibility filter already excludes `source != scheduled`).

## Acceptance criteria

- [ ] `POST /api/monitors/:id/check` returns promptly (enqueue, not synchronous check); unique manual check id per invocation.
- [ ] Manual result lands in `check_results` with `source=manual`, `affects_state=0`.
- [ ] Failing manual check changes nothing: no counter change, no incident, no notification (tested on a DOWN-bound fixture).
- [ ] Manual results never appear in eligible uptime data (coordinate/verify with 020's filter).
- [ ] Audit event written; archive/disabled monitors rejected.

## Implementation notes

- Reuse 009's handler with a branch on `source`; do not fork a second handler path.

## TDD notes

- Integration: enqueue manual check against failing fixture → assert result row + untouched `monitor_state` + zero `notification_events`.

## Decision gates

None expected.

## Blocked by

- 009 (check pipeline).
