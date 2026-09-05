---
id: 024
title: "Monitor detail: response-time chart, checks history, incidents, uptime windows"
type: afk
status: proposed
risk_level: low
blocked_by: ["021", "020"]
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
  PRD §27.5 monitor detail shows: current state; client; target URL; assertions; interval;
  failure/recovery thresholds; last check; last response time; 24h/7d/30d/90d uptime; response-
  time chart; recent checks; incidents; maintenance overlays; notification targets; manual check
  action. Recent check rows: time | result | HTTP status | response ms | reason | scheduled/manual
  | maintenance. Paginated histories (§24). Deep link target for email templates (§9.4/§9.5).
---

# 024 — Monitor detail: response-time chart, checks history, incidents, uptime windows

## User value

The full story of one monitor: current health, history, chart, and incidents on one page — also the deep-link destination embedded in alert emails.

## Scope

- Monitor detail page (§27.5): configuration summary (state, client, URL, assertions, interval, thresholds), last check + last response time, uptime badges for 24h/7d/30d/90d (020 endpoint).
- Response-time chart (Recharts) from checks/rollups; maintenance windows overlaid on the chart (015 data).
- Recent checks table: time | result | HTTP status | response ms | reason | scheduled/manual | maintenance — paginated (`GET /api/monitors/:id/checks`).
- Incidents list for the monitor (`GET /api/monitors/:id/incidents`) linking to incident detail (025).
- Notification targets panel (mappings from 016) with quick-edit.
- Run check now action (014) available here too.
- Stable route shape (`/monitors/:id`) used as the email deep link from 017.

## Out of scope

- Incident detail page (025), editing the monitor (023 owns forms — link out or embed edit via 023's form component).

## Acceptance criteria

- [ ] Detail page renders all §27.5 elements for fixture data, including all four uptime windows.
- [ ] Response-time chart plots fixture checks; maintenance overlay visually distinct and labeled (not color-only).
- [ ] Recent-checks pagination works; rows show all seven columns including manual/maintenance flags.
- [ ] Monitor incidents listed and linked; notification targets shown with current mappings.
- [ ] Deep-link route is stable and Access-gated (email template target verified).

## Implementation notes

- Chart data endpoint(s) may extend §24 minimally (e.g. checks list carries response_time_ms already); keep new surface minimal and documented.

## TDD notes

- Component tests for uptime badges + chart data shaping; pagination integration test.

## Decision gates

None expected.

## Blocked by

- 021 (foundation), 020 (uptime windows).
