---
id: 009
title: "monitor.check job end-to-end (config from D1, idempotent result insert)"
type: afk
status: proposed
risk_level: high
blocked_by: ["006", "008"]
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
  PRD §16.4 consumer sequence: (1) validate message; (2) execute HTTP check; (3) insert result
  using unique check_id; (4) if result already exists → already completed, do NOT repeat state
  side effects; (5) if newly inserted, evaluate state (compare-and-set ordering — wired fully in
  issue 012); (6) persist transition/incident/notification intents; (7) enqueue notification jobs
  after persistence succeeds. PRD §20: load current monitor config from D1, NOT from the Queue
  payload; reject archived; scheduled work no-ops if disabled. PRD §17.4 check_results: id =
  checkId; never store full response bodies.
---

# 009 — monitor.check job end-to-end (config from D1, idempotent result insert)

## User value

A queued check message becomes exactly one persisted, truthful check result — the core reliability path of the product, safe against duplicate delivery.

## Scope

- `monitor.check` queue handler: validate envelope → load monitor config from D1 (fresh, not from payload) → reject archived monitors; scheduled source no-ops when disabled → execute checker (006) → insert `check_results` row keyed by the deterministic/unique `check_id` → on duplicate insert, treat as already-completed and skip all side effects.
- Persistence of sanitized diagnostics only (reason code, status, response time, final URL, bounded assertion detail). No full bodies.
- `source` recorded (`scheduled|manual`); `scheduled_for`, `started_at`, `completed_at`, `affects_state` flags per PRD §17.4.
- Heartbeat refresh on work; structured log summary per check completion (event, jobId, monitorId, checkId, reasonCode, durationMs, outcome — PRD §28).
- Extension point where state evaluation (012) and notification intents (013/017) hook in after successful insert — not implemented here beyond a documented seam.

## Out of scope

- State transitions, counters, incidents (012/013), notifications (017), manual-check API (014), maintenance flagging (015), scheduler that produces these messages (010).

## Acceptance criteria

- [ ] Enqueued `monitor.check` against a fixture target (007) produces exactly one `check_results` row with correct fields/reason code.
- [ ] Delivering the identical message twice yields one result row and no duplicate side effects (idempotency test per PRD §32.2 "same job twice").
- [ ] Monitor config is read from D1 at execution time: mutating the monitor between enqueue and consume is reflected; archived monitor → no check executed; disabled scheduled check → no-op.
- [ ] No full response body ever persisted (assert on row contents).
- [ ] Structured check-completion log emitted with PRD §28 fields.

## Implementation notes

- Insert-conflict (UNIQUE PK on check id) is the idempotency gate — rely on it, not on "check-then-insert".
- Keep the handler thin: checker + repositories; no HTTP, no email here.

## TDD notes

- Use 007 fixtures + in-process consumer invocation (008); duplicate-delivery, archived, disabled, and body-persistence tests.

## Decision gates

Stop and write `DECISION_NEEDED.md` if D1 insert-conflict semantics cannot reliably express "already completed" for the chosen ID scheme.

## Blocked by

- 006 (checker), 008 (queue infra).
