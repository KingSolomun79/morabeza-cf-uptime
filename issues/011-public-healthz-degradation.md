---
id: 011
title: "Public /healthz with real degradation checks"
type: afk
status: proposed
risk_level: low
blocked_by: ["010"]
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
  PRD §19: /healthz is the ONLY public route (Access bypass configured Cloudflare-side in issue
  029). Return only {"status":"ok"} or {"status":"degraded"}; 200 healthy, 503 degraded.
  Verify: (1) D1 lightweight query works; (2) last_scheduler_at fresh (<= 3 min after
  bootstrapping); (3) last_queue_consumer_at fresh (<= 10 min, maintained by real jobs + the
  periodic synthetic queue heartbeat from 010). Never call Email Service from /healthz.
  Headers: Cache-Control: no-store, Content-Type: application/json. No version hashes, internal
  IDs, timestamps unless operationally required. Minimal is safer.
---

# 011 — Public /healthz with real degradation checks

## User value

The external watchdog contract: an honest, minimal, public signal of whether the monitoring control plane itself is alive — the endpoint Upptime will watch (issue 031).

## Scope

- Replace the 001 stub with real logic: lightweight D1 query; freshness evaluation of `last_scheduler_at` (≤3 min) and `last_queue_consumer_at` (≤10 min).
- `200 {"status":"ok"}` when all pass; `503 {"status":"degraded"}` otherwise.
- `Cache-Control: no-store`; minimal JSON; no monitor/client names, URLs, incidents, IDs, versions, or timestamps in the response (PRD §8.2 + §19).
- No Email Service call on this route.
- Route registered outside the authenticated API middleware group (it is the anonymous exception).

## Out of scope

- Cloudflare Access bypass configuration (Cloudflare-side, issue 029).
- Upptime watchdog repo (031).

## Acceptance criteria

- [ ] Fresh heartbeats + working D1 → 200 `{"status":"ok"}` exactly, with `no-store`.
- [ ] Stale `last_scheduler_at` (>3 min) or stale `last_queue_consumer_at` (>10 min) or D1 failure → 503 `{"status":"degraded"}`.
- [ ] Response contains no data beyond the status word (assert on serialized body).
- [ ] Route requires no Access identity in the app (anonymous); all other `/api/*` remain protected.
- [ ] Graceful bootstrap: before first cron/queue run, behavior documented and non-flapping (bootstrapping window per PRD §19).

## Implementation notes

- Bootstrap semantics: decide and document how "fresh" is evaluated before the first heartbeat ever lands (PRD allows ≤3 min "after bootstrapping").

## TDD notes

- Table-driven: fresh/stale scheduler, fresh/stale consumer, D1 down, bootstrap window.

## Decision gates

None expected.

## Blocked by

- 010 (heartbeats exist and are maintained).
