---
id: 005
title: "Monitors CRUD + validation + URL/SSRF safety + disable/archive semantics"
type: afk
status: proposed
risk_level: medium
blocked_by: ["004"]
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
  PRD §10 monitor model (methods GET/HEAD/POST-health-only; intervals 60/120/300/600, default 300;
  thresholds failure 1..10 default 3, recovery 1..10 default 2; timeout 1..60s default 10s;
  cache_bust optional; sensitive headers rejected per §10.9). PRD §21 SSRF rules (http/https only,
  no embedded credentials, no localhost/loopback/private/link-local/reserved IPs, caps on
  URL/header/body size). PRD §22 validation rules. PRD §23 disable/pause + archive behavior.
---

# 005 — Monitors CRUD + validation + URL/SSRF safety + disable/archive semantics

## User value

Operators can register and manage what gets monitored, with untrusted URLs and inputs rejected at the door — the configuration backbone of the product.

## Scope

- `url-safety` lib (PRD §21): scheme allowlist, credential rejection, localhost/loopback/private/link-local/reserved IP literal rejection, malformed rejection, normalization, length caps. Pure and unit-tested.
- Monitor validation (PRD §22): required fields (client, name, URL, method, interval, expected status codes, timeout, thresholds); valid HTTP status integers; interval ∈ {60,120,300,600}; timeout 1..60s; thresholds 1..10; `max_response_time_ms > 0`; `headers_json` a JSON object of strings; sensitive header names rejected (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, secret-like API-key patterns); bounded body/`body_contains`/`body_not_contains` lengths; POST allowed only with warning semantics surfaced to UI later.
- Monitor endpoints (PRD §24): `GET/POST /api/monitors`, `GET/PATCH /api/monitors/:id`, `DELETE /api/monitors/:id` (archive), plus warn-on-probable-duplicate (`client + url + method`) at create/import time (PRD §17.2).
- Disable/pause semantics (PRD §23): disable → scheduler stops (via `enabled=0`), `monitor_state.status = paused`, counters reset, open incident closed with `resolution_reason = monitor_disabled`, **no** RECOVERED notification; re-enable → status `unknown`, counters reset, `next_check_at = now`.
- Archive: sets `archived_at`, disables, keeps all history, removed from default lists.
- Audit events on all monitor mutations.

## Out of scope

- Executing checks (006), queueing (008–010), state-machine transition engine (012 — this issue only sets paused/unknown resets per §23), UI (023).

## Acceptance criteria

- [ ] URL safety matrix passes: valid http/https accepted; malformed, localhost, loopback IP, private IP, embedded credentials rejected (PRD §32.1).
- [ ] Every §22 rule enforced with tests; oversized/malformed inputs → `validation` envelope.
- [ ] Sensitive headers rejected with clear error.
- [ ] Disable → paused + counters reset + open incident closed (`monitor_disabled`), no notification enqueued; re-enable → unknown + `next_check_at = now`.
- [ ] Archive preserves history; archived monitors absent from default lists; no hard-delete path exists.
- [ ] Duplicate warning returned on probable `client + url + method` match.

## Implementation notes

- Case-sensitive body assertions in V1 (PRD §22). Do not globally unique-constrain URL (PRD §17.2).
- Reuse 004 middleware/envelopes; no parallel auth or validation style.

## TDD notes

- Unit tests for url-safety (pure function, full matrix). Integration tests for CRUD + disable/re-enable/archive against local D1.

## Decision gates

Stop and write `DECISION_NEEDED.md` if "secret-bearing header pattern" detection needs a policy beyond obvious names/patterns.

## Blocked by

- 004 (API shell + clients).
