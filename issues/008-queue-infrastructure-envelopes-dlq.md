---
id: 008
title: "Queue infrastructure: typed envelopes, consumer router, DLQ events, heartbeats"
type: afk
status: proposed
risk_level: medium
blocked_by: ["003"]
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
  PRD §16: one main Queue (morabeza-cf-uptime-checks), same Worker as producer+consumer;
  message types monitor.check, notification.send, system.heartbeat, rollup.hourly, rollup.daily,
  retention.cleanup; every message has schema version + unique job/idempotency key; envelope
  {v:1, type, jobId, payload}; validate every message with Zod; at-least-once delivery ⇒ every
  handler idempotent. DLQ morabeza-cf-uptime-checks-dlq; finite retries (max_retries 3) routed to
  DLQ; preferred: same Worker consumes DLQ, writes dead_letter_events row, acks; avoid recursive
  alert loops when Email Service itself is the failing job. PRD §37.9: one failing monitor must
  not fail the batch.
---

# 008 — Queue infrastructure: typed envelopes, consumer router, DLQ events, heartbeats

## User value

The asynchronous backbone: any job type can be enqueued and processed exactly-once-in-effect, with failed jobs visible in D1 instead of silently vanishing.

## Scope

- Queue producer helper (typed `send`/`sendBatch` with envelope `{v, type, jobId, payload}` and Zod schemas per message type).
- Queue consumer entrypoint: parse → Zod-validate → route by `type` to a registered handler; unknown/invalid messages rejected (and land in DLQ after retries).
- Idempotency contract at infra level: handlers receive `jobId` and a persistence helper; duplicate `jobId` handling pattern documented and enforced where the handler declares an idempotency table/key.
- Heartbeat: consumer updates `system_state.last_queue_consumer_at` on real work.
- DLQ consumer: writes `dead_letter_events` row (original job id, message type, sanitized payload summary, failure reason), then acks; no notifications from DLQ processing (avoids recursive email loops).
- Batch semantics: one failing message must not fail the whole batch (per-message try/catch + retry semantics, PRD §37.9).
- Wrangler queue producer/consumer wiring (local dev bindings; production queue creation stays in issue 029).

## Out of scope

- The concrete `monitor.check` handler (009), scheduler producer (010), notification/rollup handlers (017/018).

## Acceptance criteria

- [ ] Envelope validation: valid message routed to handler; invalid schema or unknown type rejected without crashing the batch.
- [ ] Duplicate delivery of the same message reaches the handler twice but infra-level idempotency hook prevents duplicate side effects for handlers that declare a dedupe key.
- [ ] DLQ message produces a `dead_letter_events` row and is acked; no email side effects.
- [ ] `last_queue_consumer_at` refreshed by consumer activity.
- [ ] A handler that throws does not prevent other messages in the batch from processing (test with one poisoned message).
- [ ] `max_retries` configured (3) with DLQ target in consumer config.

## Implementation notes

- Handlers are a registry so 009/017/018/019 plug in without touching the router.
- Never assume a message executes once (PRD §16.3).

## TDD notes

- Simulate Queue batches in Vitest (call the consumer with message arrays); include duplicate, poisoned, unknown-type, and DLQ cases.

## Decision gates

Stop and write `DECISION_NEEDED.md` if local dev runtime cannot exercise the consumer path adequately and a design change (e.g. invokable consumer function for tests) is required.

## Blocked by

- 003 (schema: dead_letter_events, system_state).
