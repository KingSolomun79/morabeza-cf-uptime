# Morabeza CF Uptime

Morabeza-owned, Cloudflare-native uptime monitoring for Morabeza Marketing websites, applications, APIs, and selected client sites.

## Authoritative implementation specification

**Read this before coding:** [`docs/PRD-SPEC.md`](./docs/PRD-SPEC.md)

The specification defines the approved V1 architecture, data model, Cloudflare resources, Queue/Cron behavior, state machine, incident rules, Cloudflare Access configuration, Cloudflare Email Service integration, UI, security requirements, tests, production rollout, and external Upptime watchdog.

## Fixed V1 architecture

```text
Cloudflare Access
       |
uptime.morabeza.digital
       |
Worker + Hono + React/Vite
       |
  D1 + one Cron + Queue
       |
HTTP monitor checks
       |
state/incidents/history
       |
Cloudflare Email Service
```

After V1 is stable, a small separate GitHub Upptime repository will monitor the public `/healthz` endpoint from outside Cloudflare.

## Environment policy

Development is local. Only production Cloudflare resources are created remotely. Do not create staging Workers, D1 databases, Queues, or staging hostnames.

## Getting started

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm dev        # app + Worker via the Cloudflare Vite plugin (local emulation)
pnpm test       # Vitest
pnpm lint       # ESLint
pnpm typecheck  # tsc across app/worker/node projects
pnpm build      # typecheck + Vite production build (Worker + static assets)
```

CI runs lint, typecheck, tests, and build on every PR and push to `main`. There is no automatic deployment; production deploys are human-approved (issue #28/#29).

## Clean-room rule

`nanasi-apps/cf-uptime-monitor` may be used only as a behavioral/UX reference. Do not fork or copy its AGPL implementation code into this repository.
