---
id: 030
title: "Initial monitor rollout + controlled failure/recovery validation"
type: hitl
status: proposed
risk_level: medium
blocked_by: ["029"]
parallel_safe: false
executor: pi
requires_tests: true
requires_review: true
requires_qa: true
requires_cso: true
requires_human_approval: true
decision_gate_required: false
context_files_to_load:
  - docs/PRD-SPEC.md
embedded_context: |
  PRD §34 Phase 9: roll out gradually — 3–5 Morabeza monitors first; observe at least one
  controlled failure/recovery test; validate false-positive behavior; then import remaining
  Morabeza sites; add client sites in batches. Do NOT import hundreds of monitors before
  alert/state logic has been observed in production. Candidate monitors (§33): morabeza.digital,
  contabilistas.cv, advogados.cv, other Morabeza properties, important application /healthz
  endpoints. Default interval 300s for ordinary sites (§10.3); 60/120s only for critical apps.
---

# 030 — Initial monitor rollout + controlled failure/recovery validation

## User value

Trust, earned gradually: real Morabeza sites monitored with alerts proven against a controlled outage — before client sites ever depend on it.

## Scope — HITL, executed with the owner

1. Add 3–5 Morabeza monitors via the admin UI/import (candidates per §33; default 300s interval; 60/120s only for genuinely critical apps).
2. Observe scheduled checks landing in D1, dashboard state, and heartbeats over at least a full day-cycle.
3. Controlled failure test on one non-production-safe target (e.g. intentionally broken path on a Morabeza-owned endpoint): verify threshold behavior (3 failures → DOWN, exactly one incident, exactly one DOWN email per target; recovery threshold 2 → RECOVERED, incident resolved with correct duration).
4. False-positive validation: confirm single transient blips do NOT page (threshold semantics in real conditions).
5. Import the remaining Morabeza sites (027 import path), then batch client sites only after a stable observation window.
6. Record rollout notes (what was added, intervals, evidence of the controlled test).

## Out of scope

- Client-site batch onboarding beyond first batches, Upptime (031), any monitor for a target the owner hasn't approved checking.

## Acceptance criteria

- [ ] 3–5 Morabeza monitors live and scheduled in production.
- [ ] Controlled failure/recovery evidenced end-to-end (incident + emails + resolution) without false pages from blips.
- [ ] At least 24h of stable heartbeats/scheduler/queue operation before batch expansion.
- [ ] Remaining Morabeza properties imported; client batches explicitly gated on owner go-ahead.
- [ ] Rollout notes committed (targets, intervals, evidence).

## Implementation notes

- Never point checks at targets the owner hasn't approved; respect §7.1 (no casual tests against real client sites outside agreed integration checks).

## TDD notes

- This is observational/production validation; evidence recorded per PRD §32.3 items 6–13 already exercised in 029 — here on real targets.

## Decision gates

- Owner go-ahead required before adding each batch beyond the initial 3–5 and before any client-site monitor.

## Blocked by

- 029 (production live + smoke gate passed).
