---
id: 012
title: "State machine: thresholds, counters, out-of-order protection + full test matrix"
type: afk
status: proposed
risk_level: high
blocked_by: ["009"]
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
  PRD §12: states unknown|up|down|paused (maintenance is an overlay, not a state). Initial:
  unknown, counters 0. DOWN at failure_threshold (default 3); RECOVERED at recovery_threshold
  (default 2). unknown→up immediately on first healthy scheduled check; initial failures need
  full failure threshold; never RECOVERED for unknown→up. Success resets failure counter;
  failure resets success counter. Only scheduled, non-maintenance, affects_state checks
  participate. PRD §16.5 out-of-order: monitor_state.last_evaluated_scheduled_for + state_version;
  only a scheduled result NEWER than last_evaluated_scheduled_for may update availability state;
  late older results stored for history but must not roll state backwards.
---

# 012 — State machine: thresholds, counters, out-of-order protection + full test matrix

## User value

Truthful UP/DOWN truth: one transient blip doesn't page anyone, and a real outage is declared and cleared exactly when thresholds say so — never rolled backwards by a late message.

## Scope

- `state-machine` service wired into the `monitor.check` pipeline after idempotent result insert (009 seam): evaluate thresholds, mutate `monitor_state` (status, consecutive counters, failure_sequence_started_at, last_* diagnostics, open_incident_id, state_version, last_evaluated_scheduled_for).
- Transitions per PRD §12: `unknown→up` on first healthy scheduled check; threshold-crossing DOWN; threshold-crossing recovery; counter resets; paused monitors never transition via checks.
- Out-of-order guard: compare-and-set on `last_evaluated_scheduled_for`/`state_version`; stale results persist as history only.
- Extension seam for DOWN/RECOVERED transition events (incidents in 013, notifications in 017 subscribe here).
- Maintenance/manual exclusion honored via `affects_state`/maintenance flags set upstream (014/015 set them; machine just honors).

## Out of scope

- Incident row lifecycle (013), notification enqueue (017), manual/maintenance producers (014/015).

## Acceptance criteria

- [ ] Full PRD §32.1 state-machine matrix passes: unknown→up; unknown failures don't declare DOWN early; 3rd failure declares DOWN (default threshold); continued failure doesn't create a second transition; 1st success while DOWN doesn't recover (threshold 2); 2nd success recovers; counters reset correctly; out-of-order result cannot roll state backwards; paused monitor doesn't transition; maintenance result doesn't transition; manual result doesn't transition.
- [ ] State updates use compare-and-set ordering — concurrent/late delivery cannot corrupt or regress state (tested with interleaved deliveries).
- [ ] `unknown→up` emits no RECOVERED intent.
- [ ] `last_evaluated_scheduled_for` + `state_version` maintained on every applied transition.

## Implementation notes

- Deterministic unit-testable core: `(currentState, thresholds, result) → nextState | no-op` pure function + a thin persistence adapter doing the CAS update.

## TDD notes

- The PRD §32.1 matrix is the acceptance test list; add interleaving/out-of-order cases with shuffled message orders.

## Decision gates

Stop and write `DECISION_NEEDED.md` if CAS semantics on D1 require a schema change beyond `state_version`/`last_evaluated_scheduled_for`.

## Blocked by

- 009 (result persistence + pipeline seam).
