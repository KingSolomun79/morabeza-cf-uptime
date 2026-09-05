---
id: 002
title: "ADRs: clean-room, single-worker, queue-execution"
type: afk
status: proposed
risk_level: low
blocked_by: []
parallel_safe: true
executor: pi
requires_tests: false
requires_review: true
requires_qa: false
requires_cso: false
requires_human_approval: false
decision_gate_required: false
context_files_to_load:
  - docs/PRD-SPEC.md
embedded_context: |
  PRD §30 suggests docs/adr/0001-clean-room.md, 0002-single-worker.md, 0003-queue-monitor-execution.md.
  PRD §1: this spec is source of truth unless a later explicitly approved decision record supersedes it.
---

# 002 — ADRs: clean-room, single-worker, queue-execution

## User value

Records the three load-bearing architectural decisions as reviewable ADRs so future contributors and agents inherit the rationale, not just the rules.

## Scope

- `docs/adr/0001-clean-room.md` — behavioral/UX reference only (`nanasi-apps/cf-uptime-monitor`, AGPL-3.0); no fork/copy/translation of its code, schema, tests, or styling (PRD §3).
- `docs/adr/0002-single-worker.md` — one Worker serves API + React UI + Cron + Queue events; no separate services (PRD §4.1–4.2).
- `docs/adr/0003-queue-monitor-execution.md` — Cron schedules, Queue executes checks; Cron never performs target HTTP requests; at-least-once delivery ⇒ idempotent handlers (PRD §4.5–4.7, §15–16).
- Each ADR: context, decision, consequences, alternatives considered, PRD section references.

## Out of scope

- Any code changes.
- ADRs for decisions not yet made.

## Acceptance criteria

- [ ] Three ADR files exist under `docs/adr/` with the suggested names.
- [ ] Each states status (accepted), context, decision, consequences, and cites the governing PRD sections.
- [ ] No contradiction with PRD §4 confirmed decisions.

## Implementation notes

- ADRs document/justify the PRD decisions; they must not silently amend them (PRD §1).

## TDD notes

- Not applicable (docs only).

## Decision gates

None expected.

## Blocked by

- None — can start immediately (parallel with 001).
