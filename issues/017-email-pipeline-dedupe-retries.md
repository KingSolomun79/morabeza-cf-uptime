---
id: 017
title: "Email pipeline: dedupe keys, DOWN/RECOVERED queue jobs, retries, test email"
type: afk
status: proposed
risk_level: medium
blocked_by: ["013", "016"]
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
  PRD §9: Email Service via `send_email` binding NAME=EMAIL; only meaningful transitions email:
  UP→DOWN sends DOWN, DOWN→UP sends RECOVERED; never on every failed check; NO RECOVERED when
  never DOWN; one email per notification target (independent delivery/retry state); every send
  has a unique dedupe key {incident_id}:{type}:{target_id}. §9.6: persist transition → create
  notification_events rows → enqueue notification.send → consumer sends via EMAIL → mark sent /
  retry transient. Not tightly coupled to the check transaction. Templates §9.4/§9.5 (DOWN:
  client, monitor, URL, reason, status, response time, consecutive failures, incident open time,
  link; RECOVERED: client, monitor, recovered time, outage duration, response time, link).
  §37: duplicate notification jobs don't duplicate emails; email failure doesn't roll back state.
  Sender default "Morabeza Uptime <uptime@morabeza.digital>", configurable (DEFAULT_FROM_EMAIL).
---

# 017 — Email pipeline: dedupe keys, DOWN/RECOVERED queue jobs, retries, test email

## User value

Operators get exactly one DOWN and one RECOVERED email per target per incident — no spam on every failed check, no lost alerts when a send hiccups.

## Scope

- Transition → intent: on state-machine DOWN/RECOVERED crossings (012/013 seam), after incident persistence succeeds, create `notification_events` rows (one per resolved target, `status=pending`, dedupe key `{incident_id}:{type}:{target_id}`) and enqueue `notification.send` jobs — never inline from request handlers, never inside the check transaction (PRD §42.14, §9.6).
- `notification.send` queue handler: load event → claim (`sending`) → send via `EMAIL` binding → mark `sent` (+`provider_message_id`, `sent_at`) or record `failed`/attempts/`last_error`; transient failures throw for Queue retry; dedupe on `dedupe_key` UNIQUE makes duplicate jobs inert (PRD §37.3).
- Email templates DOWN/RECOVERED per §9.4/§9.5 with all listed fields + deep link to Access-protected monitor detail page; configurable sender (`DEFAULT_FROM_EMAIL`).
- No RECOVERED when monitor never reached DOWN (unknown→up path emits nothing).
- `POST /api/notification-targets/:id/test` (PRD §24): sends a test email through the same pipeline (`type=test`, independent of incidents).
- Local/test email transport: injectable mock so tests never send real email.
- Heartbeat/log per send outcome; no email body content or secrets in logs (PRD §28).

## Out of scope

- UI for targets/test button (026), Cloudflare Email Service onboarding (029), DLQ interplay (008 already handles generic DLQ; avoid recursive loops — no notification jobs produced from DLQ processing).

## Acceptance criteria

- [ ] DOWN transition creates exactly one pending event per target and one send per event; RECOVERED likewise.
- [ ] Duplicate delivery of a `notification.send` job sends nothing extra (dedupe-key test per PRD §32.1 notifications matrix).
- [ ] One transition produces one email per target — never per failed check (only threshold crossings enqueue).
- [ ] Send failure increments `attempts`, records `last_error`, retries via Queue; state transition itself is never rolled back by email failure (PRD §37.5).
- [ ] `unknown→up` produces zero notification events.
- [ ] Test email works with no incident involved.
- [ ] DOWN/RECOVERED subjects match `[DOWN] name — monitor` / `[RECOVERED] name — monitor` pattern with full §9.4/§9.5 body fields.

## Implementation notes

- `notification_events` row creation + job enqueue ordered after incident persistence (PRD §16.4 steps 6–7).
- Marking `sending` must be idempotent-friendly (re-claim safe under duplicate delivery).

## TDD notes

- PRD §32.1 notifications list = test checklist; add mock-transport integration tests incl. transient-failure retry and duplicate job.

## Decision gates

Stop and write `DECISION_NEEDED.md` if the `send_email` binding API differs from PRD §9.2 (follow current Cloudflare docs, preserve architecture — PRD §42.20).

## Blocked by

- 013 (incidents own transition anchors), 016 (target resolution).
