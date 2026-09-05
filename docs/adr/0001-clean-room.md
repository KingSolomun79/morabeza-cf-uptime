# ADR 0001 — Clean-room implementation

- **Status:** Accepted
- **Date:** 2026-09-05
- **Governing spec:** `docs/PRD-SPEC.md` §3 (Clean-room implementation requirement)

## Context

Morabeza needs an uptime monitor with product ideas similar to existing tools. The
repository `nanasi-apps/cf-uptime-monitor` is a useful behavioral/UX reference
(monitor management, dashboard concepts, status/history views, response-time
visualization, maintenance windows, incident presentation, state-change
notifications, bulk import), but it is licensed AGPL-3.0.

## Decision

Morabeza CF Uptime is designed and implemented independently from
`docs/PRD-SPEC.md` and public Cloudflare platform documentation. The reference
repository may inform *what* the product does, never *how its code is written*.

We do not:

- fork the reference repository;
- copy its source files, components, database schema definitions, tests, or CSS/visual styling;
- copy internal function implementations;
- mechanically translate its source code;
- vendor its source into this repository.

Cloudflare's official templates and documentation are excluded from this rule —
they are platform scaffolding, not the AGPL reference product.

## Consequences

- All implementation derives from the PRD; PRD section references are cited in issues and code comments.
- UI/UX is independently designed; conceptual inspiration from modern uptime dashboards is allowed, pixel replication is not (PRD §27.1).
- No AGPL-covered code enters this codebase, keeping Morabeza's licensing position clean.

## Alternatives considered

- **Fork the reference project.** Rejected: fastest start, but forfeits ownership, imports AGPL obligations, and drags in architecture that contradicts the approved Cloudflare-native design.
- **Clean-room from the PRD (chosen).** Slower start, but the product is Morabeza-owned, license-clean, and matches the approved architecture exactly.

## References

- PRD-SPEC.md §3.1–§3.2
- https://github.com/nanasi-apps/cf-uptime-monitor (behavioral/UX reference only)
