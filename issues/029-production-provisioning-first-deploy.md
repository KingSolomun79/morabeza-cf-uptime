---
id: 029
title: "Production provisioning + first deploy + smoke gate (owner checklist)"
type: hitl
status: proposed
risk_level: critical
blocked_by: ["028"]
parallel_safe: false
executor: pi
requires_tests: true
requires_review: true
requires_qa: true
requires_cso: true
requires_human_approval: true
decision_gate_required: true
context_files_to_load:
  - docs/PRD-SPEC.md
embedded_context: |
  PRD §34 Phase 8 — the FIRST remote Cloudflare resource phase; §35 owner-action checklist;
  §6 resource model (Worker morabeza-cf-uptime; D1 morabeza-cf-uptime-db with --location=weur;
  Queues morabeza-cf-uptime-checks + -dlq; custom hostname uptime.morabeza.digital; bindings
  DB, CHECK_QUEUE, EMAIL). NO staging resources (§4.10). §8 Access: deny-by-default app on
  uptime.morabeza.digital/* with Allow policy of approved operators; specific public BYPASS for
  /healthz taking precedence. §9 Email Service onboarding for morabeza.digital, verify
  destination addresses, sender uptime@morabeza.digital (owner may change). §32.3 full smoke
  checklist (15 items) before declaring production ready. Least-privilege deploy credentials in
  GitHub production environment. Human-approved at every gate (§42.19).
---

# 029 — Production provisioning + first deploy + smoke gate (owner checklist)

## User value

Morabeza gets the real thing: the monitor live at `https://uptime.morabeza.digital`, protected by Access, alerting via Cloudflare Email Service — proven by the full smoke gate before anyone trusts it.

## Scope — this is a HITL decision-gate issue executed WITH the owner

Owner actions (PRD §35 checklist, executed in order):

1. Onboard `morabeza.digital` in Cloudflare Email Service; allow bounce MX/SPF/DKIM config; verify destination alert address(es); confirm sender (recommended `uptime@morabeza.digital`).
2. Confirm Access operator email(s)/identity rule.
3. Create Cloudflare Access application for `uptime.morabeza.digital/*` (Allow policy, approved operators only, deny-by-default).
4. Create the more-specific Access path/app for `/healthz` with public Bypass policy, verified to take precedence (§8.2).
5. `wrangler d1 create morabeza-cf-uptime-db --location=weur` → fill `database_id` into wrangler config (replacing the 028 placeholder).
6. `wrangler queues create morabeza-cf-uptime-checks` + `wrangler queues create morabeza-cf-uptime-checks-dlq`.
7. Confirm custom hostname `uptime.morabeza.digital`.
8. Configure least-privilege Cloudflare deploy credentials in the GitHub `production` environment.
9. Approve first production D1 migration (via 028 workflow / wrangler, human-approved).
10. Approve first production deployment (028 workflow dispatch).
11. Run the FULL production smoke gate — all 15 items of PRD §32.3, including: healthz 200 minimal; anonymous `/` + `/api/monitors` blocked; operator login works; client + monitor creation; scheduled check reaches Queue + D1; manual check no-uptime-effect; controlled failure opens exactly one incident; exactly one DOWN email per target; controlled recovery + exactly one RECOVERED per target; maintenance suppression; duplicate job no-duplicate-effects; fresh Cron + Queue heartbeats on the System page; test email from admin UI.

Agent role: prepare exact commands, verify each step's output, fill config values when the owner provides them, drive the smoke checklist and record evidence.

## Out of scope

- Importing real monitors (030), Upptime (031), any staging resource (never, §4.10).

## Acceptance criteria

- [ ] All §35 checklist items checked with recorded evidence (command outputs, screenshots or Access/Email screenshots from owner).
- [ ] `/healthz` public and minimal from the open internet; everything else Access-challenged.
- [ ] `workers.dev` + preview URLs disabled in production.
- [ ] Full §32.3 smoke list (1–15) passes and is documented in a production-readiness note.
- [ ] No staging resources exist; no secrets committed.

## Implementation notes

- Decision gate: this issue MUST NOT start until 028 is merged and the owner explicitly authorizes resource creation (PRD §42.7: no production resources until code is locally testable and the owner gate is reached).
- If Email Service or Access APIs differ from PRD examples, follow current Cloudflare docs, preserve architecture (§42.20).

## TDD notes

- Smoke gate IS the test suite here; record each item's evidence in the runbook/production-readiness doc.

## Decision gates

- Mandatory `DECISION_NEEDED.md`/owner sign-off before: first `d1 create`, first migration apply, first deploy. Any smoke-gate failure blocks rollout (030).

## Blocked by

- 028 (deploy workflow + config + smoke script ready).
