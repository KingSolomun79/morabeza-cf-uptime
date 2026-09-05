---
id: 023
title: "Monitors UI: list, create/edit forms, actions (run now, pause, archive, duplicate)"
type: afk
status: proposed
risk_level: low
blocked_by: ["021", "005"]
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
  PRD §27.4 monitor list actions: create, edit, duplicate configuration, run check now, pause/
  resume, archive, filter/search, bulk import (import UI is issue 027). §10.1: UI must warn that
  POST monitors may execute more than once. §22 validation rules mirrored client-side.
  §27.4: no destructive permanent delete through the normal UI. §23: pause/resume semantics with
  the state effects delivered in 005.
---

# 023 — Monitors UI: list, create/edit forms, actions (run now, pause, archive, duplicate)

## User value

Operators manage the whole monitor fleet — create, tune, pause, test, retire — without touching D1 or config files.

## Scope

- Monitors list page: filter/search (client, status, text), status badges, interval/last-check columns, link to detail (024), entry points for all actions.
- Create/edit form mirroring every §22 rule with client-side + server-side validation; fields for client, name, URL, method, interval, expected statuses, body assertions, max response time, timeout, thresholds, cache_bust, custom headers (with sensitive-name rejection surfaced).
- POST method warning in the form (may execute more than once — PRD §10.1).
- Actions: Run check now (014 endpoint) with optimistic feedback; Pause/Resume (005 semantics); Archive with confirm (no permanent delete anywhere in the UI); Duplicate configuration (prefill create form).
- Duplicate-probability warning from 005 surfaced on create.

## Out of scope

- Bulk import page (027), monitor detail page (024).

## Acceptance criteria

- [ ] Create a monitor through the UI end-to-end on local dev; it appears in the list and (with 010) gets scheduled.
- [ ] All §22 validation errors render inline with field-level messages; sensitive header rejected visibly.
- [ ] POST warning shown when method=POST selected.
- [ ] Run check now triggers a manual check (visible as manual in history later); Pause/Resume and Archive reflect §23 semantics; no permanent-delete control exists.
- [ ] Duplicate action prefills a valid create form; duplicate-client-url-method warning appears.

## Implementation notes

- Single source of truth for validation: reuse the same Zod schemas server-side and client-side where practical.

## TDD notes

- Form validation unit tests mirroring §22; interaction tests for actions (mocked API); confirm-guard test on archive.

## Decision gates

None expected.

## Blocked by

- 021 (foundation), 005 (CRUD + action semantics).
