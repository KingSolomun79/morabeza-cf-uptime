---
id: 027
title: "Bulk import/export (JSON API + UI)"
type: afk
status: proposed
risk_level: medium
blocked_by: ["021", "005"]
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
  PRD §25.1 import: JSON format (canonical example with client, name, url, method,
  intervalSeconds, expectedStatusCodes, failureThreshold, recoveryThreshold); validate the
  complete file before committing where practical; report row-level validation failures; detect
  probable duplicates; never accept secrets in sensitive headers; create an audit event; NOT
  trigger mass immediate checks in one request handler — due monitors picked up by the scheduler.
  §25.2 export: JSON of monitor configuration, excluding any future secret values; useful for
  backup/review. §27.2 nav has "Import / Export".
---

# 027 — Bulk import/export (JSON API + UI)

## User value

Onboard many monitors at once (the realistic Morabeza/client rollout path) and back the configuration up — without hand-creating rows.

## Scope

- `POST /api/monitors/import`: JSON array body per §25.1 canonical shape; validate the entire file first; respond with row-level results (created / failed-with-reasons / duplicate-warning on probable `client + url + method`); commit only valid rows (per-row or all-or-nothing "where practical" — implementer chooses, document it); size-bounded; rejects sensitive headers; audit event for the import action; no mass immediate checks (scheduler picks them up via `next_check_at`).
- `GET /api/monitors/export`: JSON export of monitor configuration (same shape as import for round-tripping), excluding secret-bearing fields (headers sanitized per §10.9 policy).
- Import/Export UI page (§27.2 nav): paste/upload JSON, preview validation results table, see per-row outcomes; export button downloading JSON.
- Round-trip: export → import yields same logical configuration (duplicates flagged, not duplicated).

## Out of scope

- CSV/other formats (V1 is JSON per §25), mass enable/disable operations.

## Acceptance criteria

- [ ] Valid multi-row import creates monitors that the scheduler picks up naturally; no check storm triggered by the import call itself.
- [ ] Invalid rows reported with row index + reason; valid rows handled per documented commit policy; malformed JSON → validation envelope.
- [ ] Probable duplicates warned; sensitive headers rejected anywhere in the file.
- [ ] Export produces spec-shaped JSON, secret-free; import(export(x)) round-trips cleanly on fixtures.
- [ ] Audit event recorded for imports; size caps enforced.

## Implementation notes

- Reuse 005's monitor validation Zod schema per row — one validator, two entry points.

## TDD notes

- Mixed valid/invalid fixtures; duplicate detection; oversized file; round-trip property test.

## Decision gates

Stop and write `DECISION_NEEDED.md` if "validate complete file before committing" conflicts with partial-commit UX for large files.

## Blocked by

- 021 (foundation), 005 (monitor validation + creation).
