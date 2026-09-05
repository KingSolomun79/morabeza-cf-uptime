---
id: 016
title: "Notification targets + monitor mappings + defaults"
type: afk
status: proposed
risk_level: low
blocked_by: ["004"]
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
  PRD §17.7 notification_targets: unique email, enabled, is_default. §17.8
  monitor_notification_targets (monitor_id, target_id) PK; if a monitor has no explicit mapping,
  use enabled targets with is_default = 1. §24 endpoints: GET/POST /api/notification-targets,
  PATCH/DELETE /api/notification-targets/:id, POST /api/notification-targets/:id/test
  (the test send itself is issue 017). Email addresses are not secrets.
---

# 016 — Notification targets + monitor mappings + defaults

## User value

Operators control exactly who gets paged, per monitor or via defaults — the routing half of alerting, ready for the email pipeline to consume.

## Scope

- Endpoints (PRD §24): `GET/POST /api/notification-targets`, `PATCH /api/notification-targets/:id`, `DELETE /api/notification-targets/:id` (disable/remove mapping semantics per spec; email UNIQUE).
- Monitor↔target mapping management under monitor update or dedicated sub-routes (kept consistent with §24 surface; mapping rows per §17.8).
- Recipient resolution service: `resolveTargets(monitorId)` → explicit enabled mappings, else enabled `is_default=1` targets — the single function 017 consumes.
- Validation: valid email format; `is_default` invariants (at least possible to have none → monitors then silently have no recipients; surface this state in API response for UI to warn later).
- Audit events on mutations. Test-send endpoint route stub returns `not_implemented` until 017 lands (or is deferred entirely to 017 — implementer's choice, note it).

## Out of scope

- Email sending/dedupe/retry (017), UI (026).

## Acceptance criteria

- [ ] Target CRUD works; duplicate email rejected; enable/disable respected.
- [ ] Mapping CRUD works; PK constraint enforced (no duplicate pairs).
- [ ] `resolveTargets` returns explicit mappings when present, enabled defaults otherwise — unit-tested for all branches (none/explicit/default/mixed-disabled).
- [ ] Audit events on mutations.
- [ ] Deleting/removing a target leaves no dangling notification intents for future incidents.

## Implementation notes

- Keep `resolveTargets` pure and injectable — 017's pipeline and tests depend on its determinism.

## TDD notes

- Branch tests for resolution; CRUD integration tests; uniqueness constraints.

## Decision gates

None expected.

## Blocked by

- 004 (API shell).
