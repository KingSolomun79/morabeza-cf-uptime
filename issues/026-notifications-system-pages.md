---
id: 026
title: "Notifications + System pages (targets, test email, heartbeats, dead letters)"
type: afk
status: proposed
risk_level: low
blocked_by: ["021", "017"]
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
  PRD §27.9 Notifications: manage verified operational recipient records + monitor associations;
  Send test email action; clearly show send failure state/history. §27.10 System page: Worker app
  status; D1 health; scheduler last heartbeat; queue consumer last heartbeat; raw retention
  policy; last hourly rollup; last daily rollup; last cleanup; unresolved dead-letter events;
  build/version metadata for authenticated users only; Email Service test action. Do NOT expose
  Cloudflare account IDs/tokens/secrets. §24 endpoints: GET /api/system, GET/PATCH
  /api/dead-letters(+/:id).
---

# 026 — Notifications + System pages (targets, test email, heartbeats, dead letters)

## User value

Operators can answer "who gets alerted and did alerting work?" and "is the monitoring system itself healthy?" — plus resolve stuck dead letters — without D1 access.

## Scope

- `GET /api/system` (PRD §24): heartbeat timestamps, D1 reachability, retention policy values, last rollup/cleanup times, unresolved dead-letter count, build/version metadata (authenticated users only — all of /api already is).
- Notifications page (§27.9): target list CRUD (016), per-monitor associations editor, **Send test email** button (017 test endpoint), send failure state/history surfaced from `notification_events` (status, attempts, last_error).
- System page (§27.10): renders `/api/system` data — scheduler + queue heartbeats with fresh/stale indicator, retention policy, last hourly/daily rollup + cleanup, Email Service test action (017), unresolved dead-letter events list.
- Dead-letter ops (PRD §24): `GET /api/dead-letters`, `PATCH /api/dead-letters/:id` (resolve with notes); UI list + resolve flow.
- Secret hygiene: no account IDs, tokens, or secrets anywhere on these pages (PRD §27.10).

## Out of scope

- Alert routing logic (016/017 already own it), DLQ consumption itself (008).

## Acceptance criteria

- [ ] Notification targets CRUD + mapping editor work; test email action sends and reflects outcome; failed sends visible with attempts/error.
- [ ] System page shows live heartbeats with obvious stale indicators; retention + last rollup/cleanup values correct.
- [ ] Dead-letter list + resolve-with-notes flow works against 008-written rows.
- [ ] No Cloudflare account IDs/tokens/secrets render anywhere on either page (verify in tests).
- [ ] `/api/system` rejects unauthenticated requests like all `/api/*`.

## Implementation notes

- Heartbeat freshness thresholds shared with 011's logic — extract one shared helper.

## TDD notes

- API tests for `/api/system` + dead-letter resolve; component tests for stale indicators; secret-hygiene assertions.

## Decision gates

None expected.

## Blocked by

- 021 (foundation), 017 (email events/test action).
