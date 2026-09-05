---
id: 025
title: "Clients + Incidents + Maintenance pages"
type: afk
status: proposed
risk_level: low
blocked_by: ["021"]
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
  PRD §27.6 Clients: client detail summarizes monitor count, Up/Down/Paused counts, open
  incidents, aggregate uptime indicators, monitors list. No client logins in V1. §27.7 Incidents:
  open first, then resolved; detail shows monitor, client, first failure, threshold-crossing
  check, open reason, recovery, duration, related check timeline. §27.8 Maintenance:
  create/edit/cancel; fields title, description, scope, starts at, ends at; times DISPLAYED in
  Atlantic/Cape_Verde by default; persisted timestamps remain UTC.
---

# 025 — Clients + Incidents + Maintenance pages

## User value

Operators can work per-client (what's down for customer X?), triage incident history, and plan maintenance windows — the operational backlog views.

## Scope

- Clients page + client detail (§27.6): monitor/status counts, open incidents, aggregate uptime indicators, member monitors list. Client CRUD links to 004 endpoints; no client login concept anywhere.
- Incidents page (§27.7): open-first listing with pagination; incident detail with monitor, client, first failure, threshold-crossing check, open reason, recovery info, duration, and a related-check timeline (from 013 data + check history).
- Maintenance page (§27.8): create/edit/cancel window forms (title, description, scope global|client|monitor with dependent scope picker, starts/ends), active/upcoming/past sections; display timezone default `Atlantic/Cape_Verde`, persisted UTC.
- Cancellation confirm flow; no hard delete.

## Out of scope

- Editing monitors from client detail (link to 023), notification pages (026), public/client-facing views (V1 non-goal §39).

## Acceptance criteria

- [ ] Client detail shows correct counts + member monitors for fixtures; aggregate uptime indicator renders.
- [ ] Incidents list orders open first; detail renders the full §27.7 field set including check timeline.
- [ ] Maintenance create/edit/cancel work end-to-end; invalid ranges (ends ≤ starts) blocked client+server side; scope picker enforces §14.2 rules.
- [ ] Displayed datetimes default to Atlantic/Cape_Verde while stored values stay UTC (verify a -1h offset case).
- [ ] Cancelled windows move to past/cancelled view and never re-activate.

## Implementation notes

- Reuse 021 time utilities; one timezone helper, used everywhere.

## TDD notes

- Component tests for the scope picker rules + timezone rendering; integration tests against 004/013/015 endpoints.

## Decision gates

None expected.

## Blocked by

- 021 (foundation). Data endpoints come from 004/013/015 (already merged when this starts per dependency order).
