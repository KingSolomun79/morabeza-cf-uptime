---
id: 021
title: "UI foundation: router, TanStack Query, Tailwind+shadcn shell, API client, status components"
type: afk
status: proposed
risk_level: low
blocked_by: ["004"]
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
  PRD §5.1: React, Vite, TanStack Query, React Router, Tailwind CSS + shadcn/ui, Recharts (or
  equivalent permissive), Lucide icons. §27.1: clean professional operational dashboard;
  responsive desktop-first; dark/light optional; accessible contrast; consistent status colors;
  never color alone — always text/icon labels; quick scanning over decoration; independent design
  (no pixel-copying of Nanasi/Uptime Kuma). §27.2 sidebar: Overview, Monitors, Clients, Incidents,
  Maintenance, Notifications, Import / Export, System.
---

# 021 — UI foundation: router, TanStack Query, Tailwind+shadcn shell, API client, status components

## User value

The operational app gets its skeleton: navigation, theming, data-fetching, and the shared status vocabulary every page reuses.

## Scope

- React Router routes for all eight sidebar sections (placeholder pages ok); responsive desktop-first shell with sidebar per §27.2.
- TanStack Query client + `src/lib/api.ts` client that speaks the 004 error envelopes (typed errors, correlation id surfacing).
- Tailwind + shadcn/ui base components; Lucide icons; optional dark/light theme.
- Shared status components: `StatusBadge` for UP/DOWN/UNKNOWN/PAUSED/MAINTENANCE with color + text + icon (never color alone), and shared time formatting (UTC persisted; display timezone utility ready for `Atlantic/Cape_Verde` default per §27.8).
- App build wired through the existing Vite/Cloudflare static-assets pipeline (001) — same-unit deploy.
- CSP-friendly frontend (no inline-script assumptions; §29.11 coordination lands with 028).

## Out of scope

- Any real page content (022–027), `/api/dashboard` aggregation (022).

## Acceptance criteria

- [ ] All eight nav sections render placeholder pages at their routes; shell responsive at desktop and narrow widths.
- [ ] API client handles success + every §38 error envelope category in a typed way (unit-tested).
- [ ] StatusBadge renders all five canonical labels with text+icon, tested for a11y basics (label not color-only).
- [ ] `pnpm build` + CI stay green with the UI included; app served as static assets by the Worker locally.
- [ ] Independent visual design — no copied styling from the reference project (PRD §3.2, §27.1).

## Implementation notes

- Keep component library thin; shadcn primitives + a handful of app-level components.

## TDD notes

- Component tests for StatusBadge + api client error mapping; route smoke test (each route renders without crash).

## Decision gates

Stop and write `DECISION_NEEDED.md` if charting/icon library choice needs to deviate from Recharts/Lucide (must remain permissively licensed).

## Blocked by

- 004 (API envelope contract to code against).
