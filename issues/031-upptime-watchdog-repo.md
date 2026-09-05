---
id: 031
title: "Upptime watchdog repo (external /healthz checks from outside Cloudflare)"
type: hitl
status: proposed
risk_level: low
blocked_by: ["030"]
parallel_safe: false
executor: pi
requires_tests: false
requires_review: true
requires_qa: false
requires_cso: false
requires_human_approval: true
decision_gate_required: true
context_files_to_load:
  - docs/PRD-SPEC.md
embedded_context: |
  PRD §34 Phase 10 + §4.13: after the Cloudflare application is stable, create a SEPARATE GitHub
  repository, recommended name KingSolomun79/morabeza-uptime-watchdog, using Upptime ONLY for a
  small set of external checks, initially: https://uptime.morabeza.digital/healthz,
  https://morabeza.digital/, critical payment endpoint if applicable, one or more critical
  business applications. Purpose: "Detect failure of Cloudflare/Morabeza CF Uptime from an
  execution environment outside Cloudflare." Do NOT duplicate all internal monitors in Upptime.
  Upptime is permitted as an external system (§3.3); it is not the primary monitoring engine.
---

# 031 — Upptime watchdog repo (external /healthz checks from outside Cloudflare)

## User value

The watcher gets watched: if Cloudflare itself (or the monitor app) dies, an external GitHub-based system still notices and records it — closing the single-vendor blind spot.

## Scope — HITL, executed with the owner (separate repository)

1. Create the separate public/private GitHub repository `KingSolomun79/morabeza-uptime-watchdog` (owner decides visibility; note trade-offs — status exposure vs watchdog privacy).
2. Set up Upptime (upptime/upptime template) with GitHub Actions scheduling in that repo — outside this codebase entirely.
3. Configure the small initial check set per PRD §34 P10: `https://uptime.morabeza.digital/healthz` (the primary watchdog target), `https://morabeza.digital/`, critical payment endpoint if applicable, one or more critical business apps.
4. Sensible check interval + alert routing for the watchdog (Upptime's own issue-based/owner-configured alerts; independent of Cloudflare Email Service by design).
5. Document in this repo's README that the watchdog exists, what it watches, and that it must stay small (no duplication of internal monitors).

## Out of scope

- Any watchdog logic inside this Worker/repo; duplicating the full monitor list; public status page for customers (V1.1, §40).

## Acceptance criteria

- [ ] Separate repo exists with Upptime running on GitHub Actions on a schedule.
- [ ] `/healthz` monitored from outside Cloudflare; a deliberate (brief, agreed) outage of the Worker is detected by the watchdog.
- [ ] Check set stays small per §34 P10 (4-ish targets, not the internal fleet).
- [ ] Watchdog is operationally independent of Cloudflare (no dependency on the app being up to report it being down).

## Implementation notes

- Decision gate: repo visibility (public status exposure vs private) is an owner call; PRD leaves it open.
- This slice exists to explicitly close PRD release criterion §41 "External safety net" — do it only after V1 is stable (§4.13).

## TDD notes

- Not applicable (external template + config); validation is the deliberate-outage detection exercise.

## Decision gates

- Owner decision required: watchdog repo visibility + alert destination before creation.

## Blocked by

- 030 (rollout stable — V1 observed in production).
