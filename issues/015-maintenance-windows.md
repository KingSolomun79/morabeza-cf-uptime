---
id: 015
title: "Maintenance windows: CRUD + check-path exclusion semantics"
type: afk
status: proposed
risk_level: medium
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
  PRD §14: scheduled checks CONTINUE during maintenance; results persisted but flagged
  maintenance-excluded; no availability counter updates; no monitor state change; no incident
  open/close; no state-change notifications; excluded from uptime calculations. Scopes:
  global | client | monitor (global affects all). Validation: global ⇒ scope_id null; client ⇒
  valid client; monitor ⇒ valid monitor; ends_at > starts_at. §14.3: next normal scheduled check
  resumes standard evaluation; do NOT synthesize a recovery when maintenance ends. Maintenance
  is an overlay, never a monitor status (§12.1).
---

# 015 — Maintenance windows: CRUD + check-path exclusion semantics

## User value

Planned work stops alert noise and SLA corruption while still showing operators what happened during the window.

## Scope

- Maintenance endpoints (PRD §24): `GET /api/maintenance`, `POST /api/maintenance`, `PATCH /api/maintenance/:id`, `DELETE /api/maintenance/:id` (cancel — set `cancelled_at`, never hard-delete).
- Validation per §14.2: scope type/id consistency, `ends_at > starts_at`, valid references.
- Active-window resolution in the check pipeline (009 seam): given (monitor, check time) → is an active global/client/monitor window live? If yes: result persisted with `maintenance_excluded=1`, `reason_code` may record `maintenance` context; state machine, counters, incidents, notifications all bypassed.
- Window end: no synthetic recovery — next real scheduled check resumes standard evaluation (explicit test).
- Audit events on mutations.

## Out of scope

- UI (025), uptime exclusion math (020), maintenance overlay rendering on charts (024).

## Acceptance criteria

- [ ] CRUD + cancel work with full validation; cancelled windows never match again.
- [ ] Check during active window: persisted, `maintenance_excluded=1`, no state/counter/incident/notification effects — even for a hard-failing target.
- [ ] All three scopes resolve correctly (global affects every monitor; client only its monitors; monitor only itself).
- [ ] After window end, the next scheduled check evaluates state normally (and no phantom RECOVERED appears).
- [ ] Overlapping windows behave sanely (any active window ⇒ excluded).

## Implementation notes

- Window resolution must be cheap (indexed query) — it runs per check (PRD §36 performance rules).

## TDD notes

- Matrix: scope × active/inactive × healthy/failing target; end-of-window resumption; cancellation mid-window.

## Decision gates

None expected.

## Blocked by

- 009 (check pipeline seam).
