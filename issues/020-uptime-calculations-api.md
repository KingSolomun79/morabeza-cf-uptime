---
id: 020
title: "Uptime calculations + /api/monitors/:id/uptime (24h/7d/30d/90d)"
type: afk
status: proposed
risk_level: medium
blocked_by: ["018"]
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
  PRD §26: eligible = source=scheduled AND maintenance_excluded=false AND affects_state=true.
  Uptime = healthy eligible / total eligible * 100. Ranges beyond raw retention use hourly/daily
  rollups. Display 24 hours, 7 days, 30 days, 90 days. No eligible data → "No data", never 100%.
  Paused periods are not failures. Manual checks never count.
---

# 020 — Uptime calculations + /api/monitors/:id/uptime (24h/7d/30d/90d)

## User value

The number everyone cares about: truthful uptime per monitor per window, correct across raw-to-rollup boundaries and silent during paused/no-data periods.

## Scope

- `uptime` service: window (24h/7d/30d/90d) → percentage + check counts; strategy: raw `check_results` within retention; rollups for older spans; blended queries when a window straddles the retention boundary.
- `GET /api/monitors/:id/uptime?window=24h|7d|30d|90d` (PRD §24): JSON with percentage (or explicit `no_data`), eligible counts, per-window source (raw/rollup/blended).
- Eligibility filter per §26 exactly; paused intervals simply have no eligible checks (not failures).
- Endpoint feeds 022 (overview table) and 024 (monitor detail badges).

## Out of scope

- UI rendering (022/024), rollup computation (018).

## Acceptance criteria

- [ ] PRD §32.1 uptime matrix passes: manual excluded; maintenance excluded; paused/no-data handled ("No data", not 100%); rollup and raw agree on deterministic fixtures.
- [ ] 24h/7d windows resolve from raw; 30d/90d resolve from rollups; a straddling window blends correctly (fixture spanning retention boundary).
- [ ] Percentage math exact for known fixtures (e.g. 98 of 100 eligible healthy → 98.00%).
- [ ] Unknown monitor → 404 envelope; invalid window → validation envelope.
- [ ] Queries are aggregate/indexed — no full-table scans of raw history (PRD §36).

## Implementation notes

- Keep the raw/rollup switchover boundary derivable from the retention var (019) so they stay consistent.

## TDD notes

- Fixtures with known counts across boundaries; property test: percentage ∈ [0,100] or no_data; agreement test raw vs rollup.

## Decision gates

None expected.

## Blocked by

- 018 (rollups exist).
