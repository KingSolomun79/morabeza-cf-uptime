---
id: 013
title: "Incidents: open/resolve wired into check pipeline (one open per monitor)"
type: afk
status: proposed
risk_level: high
blocked_by: ["012"]
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
  PRD §12.3 DOWN threshold crossing: open ONE incident; incident start time = timestamp of the
  FIRST failure in the qualifying consecutive sequence (failure_sequence_started_at); enqueue DOWN
  notifications (notifications are issue 017). §12.4 recovery crossing: resolve open incident,
  compute outage duration, record recovery_check_id. PRD §17.5 incidents columns incl.
  resolution_reason recovered|monitor_disabled|admin; at most one open incident per monitor
  (repo layer + partial unique index if clean). §37.2 duplicate state-transition execution must
  not create duplicate incidents.
---

# 013 — Incidents: open/resolve wired into check pipeline (one open per monitor)

## User value

Every outage has one incident with a true start time and duration — the record operators and clients will be shown, and the anchor for notification dedupe.

## Scope

- Incident lifecycle hooked to state-machine transitions (012 seam): on DOWN crossing → open incident (`opened_at`, `first_failure_at` from failure sequence start, `trigger_check_id`, `open_reason_code`); on recovery crossing → resolve (`resolved_at`, `recovery_check_id`, `outage_duration_ms`, `resolution_reason = recovered`).
- At most one open incident per monitor: repository guard + partial unique index (from 003 if present).
- Duplicate-transition safety: repeated DOWN crossings while an incident is open do not open another (PRD §37.2).
- `monitor_state.open_incident_id` maintained; cleared on resolve.
- Incident close path for `monitor_disabled` (used by 005 disable semantics) and `admin` resolution reason supported at repository level.
- Read APIs (PRD §24): `GET /api/incidents` (open first, then resolved; paginated), `GET /api/incidents/:id`.
- Structured logs for incident open/resolve (PRD §28).

## Out of scope

- Notification enqueue on transitions (017), UI (025), admin close endpoint beyond repository support if not in PRD §24.

## Acceptance criteria

- [ ] Threshold DOWN crossing opens exactly one incident with correct `first_failure_at` (start of qualifying failure sequence) and `trigger_check_id`.
- [ ] Recovery crossing resolves it with correct duration and `recovered` reason.
- [ ] Duplicate/continued DOWN crossings never create a second open incident (duplicate-delivery test).
- [ ] Disable-with-open-incident path closes it with `monitor_disabled` (integrates with 005).
- [ ] `GET /api/incidents` lists open-first with pagination; detail returns full record.
- [ ] Incident open/resolve emit structured logs with incidentId/monitorId.

## Implementation notes

- Incident creation is part of the same persistence transaction window as the state transition — ordered before notification enqueue per PRD §16.4 step 6–7.

## TDD notes

- Sequence tests: failure streak → incident at threshold; recovery streak → resolve; injected duplicates; concurrent transitions racing on the one-open guard.

## Decision gates

None expected beyond 003's partial-index decision.

## Blocked by

- 012 (state transitions to hook).
