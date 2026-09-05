---
id: 004
title: "API shell (error envelopes, Zod, Access middleware, audit) + Clients CRUD"
type: afk
status: proposed
risk_level: low
blocked_by: ["003"]
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
  PRD §24: JSON responses, consistent error envelopes; all routes except /healthz are
  Access-protected. PRD §8.4: require Access identity evidence, reject missing context,
  audit with Access email (never client-supplied), Origin check on mutations, JSON-only
  mutations, no permissive CORS. PRD §38: stable error categories (validation, not_found,
  conflict, authentication_required, forbidden, ...). PRD §17.14 audit_events on admin mutations.
---

# 004 — API shell (error envelopes, Zod, Access middleware, audit) + Clients CRUD

## User value

Operators can manage clients (groupings for Morabeza vs customer sites) through a protected, consistent API — the first real control-plane capability, and the template every later endpoint follows.

## Scope

- Shared API middleware on `/api/*`: Access identity context extraction (production: verify Access JWT/Jwt-Assertion context per PRD §8.4; local dev: injectable test identity), reject unauthenticated, capture actor email for audit.
- Error envelope helper with PRD §38 categories; sanitized messages; correlation/request ID per request.
- Zod validation helpers; JSON-only enforcement on JSON mutation routes; Origin check (`https://uptime.morabeza.digital`) for mutating methods (configurable origin for local dev).
- `audit_events` repository + helper; mutations write audit rows with Access actor email (never trust client-supplied email).
- Clients endpoints (PRD §24): `GET /api/clients`, `POST /api/clients`, `GET /api/clients/:id`, `PATCH /api/clients/:id`, `DELETE /api/clients/:id` (archive — set `archived_at`, never hard-delete).
- Client validation: `name` required, unique `slug`, `active` flag, bounded notes.

## Out of scope

- Monitors endpoints (issue 005), notification targets (016), Access configuration itself (Cloudflare-side, issue 029).
- CSP/security headers hardening pass (can land with 028 if not trivially included here).

## Acceptance criteria

- [ ] Unauthenticated `/api/*` request rejected with `authentication_required` envelope; identity email available to handlers.
- [ ] Validation failure → `validation` envelope with field details; unknown route → `not_found`; no stack traces leak.
- [ ] Clients CRUD works end-to-end on local D1; archive preserves the row and excludes it from default lists.
- [ ] Every mutating client request writes an `audit_events` row with actor email + entity id.
- [ ] Mutations without matching Origin are rejected; non-JSON bodies on JSON routes rejected.
- [ ] Unit/integration tests cover envelope shapes, auth rejection, audit write, archive semantics.

## Implementation notes

- Local dev stub must be clearly separated so production path cannot accidentally trust headers (PRD §8.4 "do not trust client-supplied email").
- Audit metadata must not contain sensitive request bodies (PRD §17.14).

## TDD notes

- Table-driven tests: each error category, each CRUD path, archive-not-delete, audit write, origin rejection.

## Decision gates

Stop and write `DECISION_NEEDED.md` if local Access emulation requires a design that could weaken the production check.

## Blocked by

- 003 (schema + clients table).
