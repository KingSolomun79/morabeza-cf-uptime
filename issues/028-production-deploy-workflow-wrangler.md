---
id: 028
title: "Production deploy workflow + final wrangler.jsonc + smoke-test script"
type: afk
status: proposed
risk_level: medium
blocked_by: ["011", "017"]
parallel_safe: false
executor: pi_tdd
requires_tests: true
requires_review: true
requires_qa: true
requires_cso: true
requires_human_approval: true
decision_gate_required: false
context_files_to_load:
  - docs/PRD-SPEC.md
embedded_context: |
  PRD §7.2: production deployment is human-approved; workflow_dispatch + GitHub `production`
  environment with required reviewer approval; sequence: verify clean CI → apply reviewed D1
  migrations → deploy Worker + assets → smoke tests → verify /healthz → Access-protected UI →
  Cron heartbeat → Queue heartbeat → test email. Never auto-deploy on merge to main.
  §31 wrangler requirements: name morabeza-cf-uptime; workers_dev=false; preview_urls=false;
  crons ["* * * * *"]; D1 binding DB (morabeza-cf-uptime-db, migrations_dir db/migrations, id
  OWNER_TO_FILL); queue producer CHECK_QUEUE + consumers with DLQ + max_retries 3; send_email
  EMAIL binding; non-secret vars (APP_ORIGIN, APP_TIMEZONE Atlantic/Cape_Verde,
  DEFAULT_FROM_EMAIL, retention days); observability logs+traces enabled (conservative sampling).
  §32.3 production smoke checklist (15 items). No API tokens in wrangler.jsonc.
---

# 028 — Production deploy workflow + final wrangler.jsonc + smoke-test script

## User value

Production ships only through a deliberate, reviewed, human-approved gate — with the exact smoke checklist automated as far as possible so the go-live decision is evidence-based.

## Scope

- Final `wrangler.jsonc` per PRD §31: production name, custom-domain readiness, `workers_dev=false`, `preview_urls=false`, one cron `* * * * *`, D1/Queue/Email bindings, DLQ consumer, `max_retries: 3`, non-secret vars, observability (logs enabled; traces with conservative head sampling). D1 `database_id` left as `OWNER_TO_FILL_AFTER_CREATION` placeholder (029 fills it). Aligned to installed Wrangler schema, not the PRD example verbatim.
- Security/response headers pass for the served app: CSP for the React app, `X-Content-Type-Options: nosniff`, sensible `Referrer-Policy`, `frame-ancestors` via CSP (PRD §29.11–14).
- GitHub Actions `deploy-production.yml`: `workflow_dispatch` only; GitHub `production` environment with required reviewer approval; steps: CI-clean check → `d1 migrations apply` (remote, production DB) → `deploy` → smoke script; **no auto-deploy on main merge**.
- Smoke-test script implementing the automatable subset of PRD §32.3 (healthz 200 minimal JSON; anonymous `/` and `/api/monitors` blocked; manual steps enumerated for Access login, email receipt, controlled failure tests).
- Runbook doc: production owner-action checklist (PRD §35) + deploy sequence (§7.2) — the manual companion 029 executes.

## Out of scope

- Creating any real Cloudflare resource (029), filling database_id, configuring Access/Email Service (029 owner actions).

## Acceptance criteria

- [ ] `wrangler.jsonc --dry-run`/deploy config validation passes with placeholder D1 id documented; no tokens in repo.
- [ ] Deploy workflow exists, dispatch-only, bound to `production` environment approval; does not run on push/merge.
- [ ] Security headers present on responses (tests for nosniff/CSP/Referrer-Policy/frame-ancestors).
- [ ] Smoke script runs locally against a target URL and checks the automatable §32.3 items, reporting pass/manual-needed per item.
- [ ] CI remains green; local dev flow unaffected by production config (local bindings per §7.1).

## Implementation notes

- Deployment credentials are GitHub `production` environment secrets configured by the owner (029) — least privilege (Workers deploy + D1 + Queues only).
- The workflow must fail loudly if migrations or smoke steps fail (no partial silent deploys).

## TDD notes

- Header tests in the Worker test suite; workflow YAML lint; smoke script unit-tested against 007-style fixtures where possible.

## Decision gates

Stop and write `DECISION_NEEDED.md` if installed Wrangler/Vite plugin output requires deviating from §31's conceptual config in a way that changes architecture (not just syntax).

## Blocked by

- 011 (healthz contract to smoke), 017 (email test action to smoke).
