---
id: 006
title: "HTTP checker: assertions, timeouts, body bounds, reason codes"
type: afk
status: proposed
risk_level: medium
blocked_by: ["001"]
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
  PRD §20 checker sequence: load config from D1 (caller's job here — checker takes config input),
  build validated URL, allowed custom headers, identifying User-Agent
  "Morabeza-CF-Uptime/1.0 (+https://uptime.morabeza.digital)", X-Morabeza-Uptime-Check-Id header,
  optional cache-bust, high-res timer, fetch with AbortController timeout, capture status/final
  URL/response time, read bounded body ONLY when body assertions configured (≤256 KiB, stop after
  bound), evaluate all assertions, classify with stable reason code, sanitized diagnostics only.
  PRD §11 reason codes: ok, timeout, network_error, unexpected_status, body_required_text_missing,
  body_forbidden_text_present, response_too_slow, invalid_response, maintenance, internal_error.
  No hidden retries of the outbound request (§20).
---

# 006 — HTTP checker: assertions, timeouts, body bounds, reason codes

## User value

The actual probing engine: decides, per check, whether a target is healthy and why — with truthful response times and bounded memory.

## Scope

- `checker` service: executes one HTTP check for a given monitor config (loaded by the caller) and returns a structured result: healthy flag, reason code (PRD §11), status code, response time, final URL, sanitized assertion details/error message.
- Assertions (PRD §10.2): expected status codes (one or more), `body_contains`, `body_not_contains` (case-sensitive), max response time, request timeout. All configured assertions must pass for healthy.
- Timeout via AbortController (default 10s; range enforced at validation layer).
- Bounded body read: only when body assertions configured; ≤256 KiB; stop reading after bound; never retain/store full body; short sanitized excerpt only where useful.
- Redirects followed; final URL recorded (PRD §10.6).
- Optional `cache_bust` behavior (no-cache headers + deterministic `__morabeza_uptime` query param based on check slot) (PRD §10.7).
- Custom non-sensitive headers applied; `X-Morabeza-Uptime-Check-Id` and identifying User-Agent added.
- No automatic retry of the outbound request (PRD §20).

## Out of scope

- Loading monitor from D1 / idempotent persistence / state effects (issues 009, 012).
- Maintenance classification (`maintenance` reason is assigned by the pipeline, not the checker).
- Queue mechanics.

## Acceptance criteria

- [ ] Unit matrix passes with mocked fetch: 200 success; configured non-200 accepted; unexpected status; timeout; network error; body-contains pass/fail; body-not-contains pass/fail; max-response-time failure (PRD §32.1).
- [ ] Body is read only when body assertions exist; bounded read verified (oversized body stops at bound); no full body in result payload.
- [ ] Response time measured around the actual request; timeout produces `timeout`, network failure produces `network_error`.
- [ ] `X-Morabeza-Uptime-Check-Id` + User-Agent present on outgoing request; cache-bust param deterministic per slot.
- [ ] Stable `reason_code` for every outcome; diagnostics sanitized.

## Implementation notes

- Pure-ish design: `fetch` injected/mockable so unit tests are deterministic and fast.
- Redirect + body interplay: bound applies to the final response body read.

## TDD notes

- Full §32.1 checker list as unit tests; add property-style test that oversized bodies never exceed the read bound.

## Decision gates

Stop and write `DECISION_NEEDED.md` if Workers runtime constraints (e.g. body streaming cancellation) force a different bounded-read mechanism than "stop after 256 KiB".

## Blocked by

- 001 (scaffold). Parallel with the data-layer track.
