---
id: 007
title: "Deterministic local test targets + checker integration tests"
type: afk
status: proposed
risk_level: low
blocked_by: ["006"]
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
  PRD §7.1 local development must support deterministic test targets for success, failure,
  timeout, slow response and body assertion behavior. Never point local automated tests at
  real client sites. PRD §32.2 integration tests use deterministic test Worker/routes or local
  fixtures for: healthy endpoint; 500 endpoint; delayed endpoint; body assertion endpoint;
  redirect endpoint; oversized-body endpoint.
---

# 007 — Deterministic local test targets + checker integration tests

## User value

Confidence that the checker behaves correctly against real HTTP semantics (redirects, slow bodies, huge payloads) — not just mocked functions — without ever touching real client sites in CI.

## Scope

- Deterministic fixture HTTP targets available to integration tests only (test-only Worker routes or Vitest-served fixtures, not shipped in the production app surface): healthy 200; 500; delayed (>timeout and slow-but-passing); body assertion (contains / not-contains); redirect chain (record final URL); oversized body (>256 KiB).
- Integration tests running the real checker (006) against those fixtures through actual `fetch`.
- Test support for invoking the scheduled handler locally via the official local scheduled route where the dev runtime supports it (hook used later by 010).
- Guardrail: automated tests never target real client sites (no real URLs in fixtures/tests).

## Out of scope

- Queue duplicate-delivery integration tests (issue 009/008 territory).
- Production smoke tests (issue 029).

## Acceptance criteria

- [ ] Integration suite covers all six fixture behaviors and asserts correct reason codes, response times, final URL after redirect, and bounded read on the oversized body.
- [ ] Fixtures are deterministic (no external network in CI).
- [ ] Local scheduled-handler invocation path demonstrated (even if the scheduler itself arrives in 010).
- [ ] No test in the suite references a real production/client URL.

## Implementation notes

- Keep fixtures in `tests/` per PRD §30 structure; ensure test routes cannot be registered in the production app.

## TDD notes

- These ARE the integration tests; keep them in the standard `pnpm test` run so CI (001) gates on them.

## Decision gates

Stop and write `DECISION_NEEDED.md` if the local runtime cannot serve fixture routes without polluting production assets.

## Blocked by

- 006 (checker to integrate against).
