---
id: 001
title: "Scaffold Hono+React/Vite Worker app, tooling, CI green"
type: afk
status: proposed
risk_level: low
blocked_by: []
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
  PRD §5 stack: TypeScript, Cloudflare Workers, Hono, React, Vite, official Cloudflare Vite
  plugin, Static Assets (frontend + Worker deploy as one unit), Vitest. PRD §34 Phase 0:
  scaffold, lockfile, CI, lint/typecheck/test scripts, no production resource creation.
  Scaffold pattern: `pnpm create cloudflare@latest --template=cloudflare/templates/vite-react-template`
  adapted INTO the existing repo (do not create a second repository).
---

# 001 — Scaffold Hono+React/Vite Worker app, tooling, CI green

## User value

Establishes the tracer bullet for the whole product: a Worker-served React app that boots locally, builds, and is verified by CI. Every later slice lands on this foundation.

## Scope

- Adapt the official Cloudflare Vite + React + Hono template into this existing repo (pnpm, TypeScript strict).
- Hono app serving: a placeholder admin page (static assets) and a stub `GET /healthz` returning `200 {"status":"ok"}` (real logic comes in issue 011).
- Tooling scripts: `dev`, `build`, `lint`, `typecheck`, `test`; Vitest configured (Workers-compatible test pool where supported).
- GitHub Actions CI workflow: on PR + push → install, lint, typecheck, unit tests, build. **No Cloudflare deployment.**
- `.gitignore`, committed `pnpm` lockfile, `wrangler.jsonc` placeholder (no production bindings yet), `compatibility_date` current.
- Do not add `nodejs_compat` (PRD §5.1) unless a concrete dependency requires it — if it does, stop and record why.

## Out of scope

- D1, Queues, Email bindings, Cron (issues 003/008/010).
- Real `/healthz` degradation logic (issue 011).
- Tailwind/shadcn/UI shell (issue 021).
- Any remote Cloudflare resource (PRD §4.10: none until Phase 8).

## Acceptance criteria

- [ ] `pnpm dev` boots the app locally through the Cloudflare Vite plugin; placeholder page renders; `/healthz` returns 200 with `{"status":"ok"}`.
- [ ] `pnpm build` produces a deployable Worker + static assets unit.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass locally and in CI.
- [ ] CI workflow runs on PR and push and performs no deploy step.
- [ ] Lockfile committed; no secrets in the repo.

## Implementation notes

- Clean-room rule (PRD §3): the Cloudflare *template* is official scaffolding, not the AGPL reference product; do not import anything from `nanasi-apps/cf-uptime-monitor`.
- Keep `wrangler.jsonc` aligned with the installed Wrangler schema, not the PRD example verbatim (PRD §31 note).
- Prefer Workers-native APIs.

## TDD notes

- One smoke test exercising the Hono app directly (e.g. `app.request("/healthz")`) asserting status + JSON shape, so CI verifies the Worker entrypoint without deploying.

## Decision gates

Stop and write `DECISION_NEEDED.md` if: a required template/deviation conflicts with PRD §5, or `nodejs_compat` becomes necessary.

## Blocked by

- None — can start immediately.
