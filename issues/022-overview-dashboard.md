---
id: 022
title: "Overview dashboard + GET /api/dashboard"
type: afk
status: proposed
risk_level: low
blocked_by: ["021"]
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
  PRD §27.3 overview shows: total active monitors; Up/Down/Unknown/Paused counts; currently in
  maintenance count; open incidents; recent recoveries; recent average response-time trend;
  latest system heartbeat state. Primary table: Client | Monitor | Status | 24h uptime | Last
  response | Last check | Incident. Filters: client, status, text search. PRD §36: aggregated
  dashboard queries, avoid N+1 history queries; paginate histories.
---

# 022 — Overview dashboard + GET /api/dashboard

## User value

The at-a-glance answer to "is everything OK right now?" — the page operators keep open all day.

## Scope

- `GET /api/dashboard` (PRD §24): aggregated counts by status, maintenance count, open incidents, recent recoveries, response-time trend (from rollups), heartbeat freshness — aggregated queries, no N+1 (PRD §36).
- Overview page (§27.3): stat cards; primary monitor table with columns Client | Monitor | Status | 24h uptime | Last response | Last check | Incident; filters (client, status, text search); pagination/limits on the table.
- 24h uptime column consumes 020's calculations (or the dashboard aggregate includes it — implementer's choice, keep it single-query).
- Status rendering via 021 components; row links to monitor detail (024 placeholder until it lands).

## Out of scope

- Monitor CRUD actions (023), detail page (024), system diagnostics page (026 — heartbeat *state* here is a summary only).

## Acceptance criteria

- [ ] Dashboard endpoint returns all §27.3 data in one aggregate response for fixture data.
- [ ] Table renders correctly with mixed statuses, filter combinations work (client + status + search).
- [ ] Empty state: zero monitors renders a useful "no monitors yet" state, not errors.
- [ ] Response-time trend renders from rollup data; heartbeats visible (fresh/stale indicator).
- [ ] Query count is bounded (aggregated; no per-monitor history fetches) — verify with fixture volume.

## Implementation notes

- Reuse 020 uptime service internally if practical rather than duplicating eligibility math.

## TDD notes

- API integration test with mixed fixture states; component test for filter logic; a11y smoke on the table.

## Decision gates

None expected.

## Blocked by

- 021 (UI foundation; also 020/012/015 data via earlier slices being merged by the time this starts).
