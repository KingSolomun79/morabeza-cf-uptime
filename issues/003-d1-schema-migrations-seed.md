---
id: 003
title: "D1 full schema + migrations + seed Morabeza client"
type: afk
status: proposed
risk_level: medium
blocked_by: ["001"]
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
  PRD §17 defines all 15 tables: clients, monitors, monitor_state, check_results, incidents,
  maintenance_windows, notification_targets, monitor_notification_targets, notification_events,
  hourly_rollups, daily_rollups, scheduler_runs, system_state, audit_events, dead_letter_events.
  PRD §33 seed: client Name=Morabeza, Slug=morabeza. No production monitors in migration SQL.
  Every D1 schema change requires a committed migration (PRD §42.10).
---

# 003 — D1 full schema + migrations + seed Morabeza client

## User value

D1 is the canonical state store for everything (PRD §4.3). This delivers the complete reviewed schema so all later slices build on one migration history instead of churning partial schemas.

## Scope

- Drizzle schema definitions for all tables in PRD §17.1–§17.15, columns/indexes exactly as specified (text IDs, UTC timestamps in one consistent format, e.g. ISO text).
- Required indexes: `clients(slug, active)`; `monitors(client_id)`, `monitors(enabled, next_check_at)`, `monitors(archived_at)`; `check_results(monitor_id, completed_at DESC)`, `(completed_at)`, `(source, completed_at)`; plus PK/uniques from the spec (`notification_events.dedupe_key` UNIQUE, `notification_targets.email` UNIQUE, rollup composite PKs).
- At-most-one-open-incident-per-monitor: enforce in repository layer; add partial unique index if it migrates cleanly on D1.
- Initial migration committed under `db/migrations`; `migrations_dir` wired in wrangler config.
- Seed migration: Morabeza client row only (PRD §33).
- Local migration workflow documented in README (apply/rollback strategy for local dev; D1 migration model documented per PRD §34 P1 acceptance).

## Out of scope

- Repository/CRUD code beyond minimal test helpers (issues 004+).
- Any remote D1 creation (Phase 8, issue 029).

## Acceptance criteria

- [ ] All 15 tables exist locally after `wrangler d1 migrations apply` (local D1), with spec columns/indexes.
- [ ] Seed Morabeza client present; no production monitor rows seeded.
- [ ] Migration re-run is safe (idempotent apply semantics per D1 migrations).
- [ ] Roundtrip test: insert/read a row in each table via Drizzle on local D1.
- [ ] Timestamp/ID conventions documented in one place (lib or schema header).

## Implementation notes

- Clean-room: schema is designed from PRD §17, not copied from the reference project (PRD §3.2).
- Do not store secrets in any column (PRD §29.6); `headers_json` is validated later at the API layer.

## TDD notes

- Test migration up on an empty local D1; test roundtrip inserts; test that the incidents partial-uniqueness (or repo guard) rejects a second open incident.

## Decision gates

Stop and write `DECISION_NEEDED.md` if a partial unique index is not cleanly supportable via the chosen migration approach (PRD §17.5 allows repo-layer enforcement as fallback).

## Blocked by

- 001 (scaffold/tooling must exist).
