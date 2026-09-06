# Morabeza CF Uptime

Morabeza-owned, Cloudflare-native uptime monitoring for Morabeza websites, applications, APIs, and selected client sites — a single Worker serving a React SPA and a JSON API, with D1 storage, Queue-based checks, Cron scheduling, and Cloudflare Email Service alerts behind Cloudflare Access.

**Live:** https://uptime.morabeza.digital · **CI:** lint + typecheck + 457 tests + build on every PR and push to `main` · **Docs:** [`docs/PRD-SPEC.md`](./docs/PRD-SPEC.md) (authoritative spec) · [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) (production operations) · [`docs/PRODUCTION-READINESS.md`](./docs/PRODUCTION-READINESS.md) (go-live evidence)

---

## 1. Features (user guide)

All surfaces live under the Access gate at `https://uptime.morabeza.digital`; the only anonymous route is `/healthz`.

| Page | What you do there |
| --- | --- |
| **Overview** (`/`) | Fleet dashboard: up/down/unknown/paused counts, open incidents, recent recoveries, 24h trend, heartbeat chip. |
| **Monitors** (`/monitors`) | Fleet table with client/status/search filters, archived toggle. Create/edit monitors; **Run check now** for an immediate manual check (never affects state or uptime); archive (never delete); enable/disable; duplicate. |
| **Monitor detail** (`/monitors/:id`) | Config summary, 24h/7d/30d/90d uptime windows, response-time chart with maintenance overlays, paginated check history (manual vs scheduled), incident list, per-monitor notification-target quick-edit. |
| **Clients** (`/clients`) | Grouping for monitors with rollups (monitor counts, open incidents, aggregate uptime). Create/edit/archive — archiving keeps history read-only; there is no delete. |
| **Incidents** (`/incidents`) | Open-first paginated list; detail (`/incidents/:id`) shows the threshold/recovery check timeline. Incidents open after N consecutive failures and resolve after M consecutive successes. |
| **Maintenance** (`/maintenance`) | Scheduled windows (global or scoped to one client/monitor) that suppress state changes, incidents, and emails while checks continue and get flagged. |
| **Notifications** (`/notifications`) | Email alert targets (create/edit/enable/disable/delete), **Send test email**, the **Apply to monitors** bulk mapper (checkbox per monitor, select all, only-changed updates), and the delivery log (status/attempts/last error). |
| **System** (`/system`) | Version, Cron/Queue/rollup heartbeats with fresh/stale state, dead-letter queue inspector with resolve-with-notes. |
| **Import/Export** (`/import-export`) | Bulk monitors: JSON import (validate-all-then-commit, duplicates skipped and flagged, never duplicated) and JSON export for backup. |

### Monitoring model in one paragraph

A single Cron trigger fires every minute. The scheduler selects due monitors, enqueues `monitor.check` jobs, and the Queue consumer performs the HTTP check (method, headers, expected status, optional body assertions, timeout), writes the result to D1, and runs the state machine: **N consecutive failures → DOWN → incident + alert emails**; **M consecutive successes → RECOVERED**. Manual checks and in-maintenance checks are recorded but never affect state. Hourly/daily rollups power long-window uptime; retention prunes raw checks (7d) and rollups (90d/730d). Every delivery is idempotent — duplicates never double-count or double-email.

---

## 2. Installation guide

### 2.1 Local development

Requires **Node 22+** and **pnpm**.

```bash
pnpm install
cp .dev.vars.example .dev.vars     # local auth mode + localhost origin (required)
pnpm db:migrate:local              # apply migrations to local D1 (wrangler SQLite)
pnpm dev                           # app + Worker via the Cloudflare Vite plugin
```

Open `http://localhost:5173`. Local mode trusts the `X-Dev-Access-Email` header automatically (the dev harness injects it; `curl` examples below show the header explicitly).

```bash
pnpm test           # Vitest (unit + integration on real miniflare D1)
pnpm lint           # ESLint
pnpm typecheck      # tsc across app/worker/node projects
pnpm build          # typecheck + Vite production build
pnpm deploy:dry-run # build + full production-config validation (no deploy, no credentials)
```

Schema changes: edit `db/schema.ts` → `pnpm db:generate` (generates `db/migrations/*.sql`) → `pnpm db:migrate:local`. Never hand-edit generated `0000_*` files.

### 2.2 Production deployment (human-approved, dispatch-only)

Production ships **only** through the **Deploy production** GitHub Action: `workflow_dispatch` trigger, GitHub `production` environment with required-reviewer approval, `main`-only, serialized. Sequence: CI-green check on the exact commit → remote D1 migrations → `wrangler deploy` (attaches the custom domain, stamps `APP_VERSION`) → automated smoke script (`/healthz`, Access gating, security headers).

One-time provisioning (Cloudflare resources, secrets, Access, hostname) is the owner checklist in [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) §1 — it was executed and evidenced in [`docs/PRODUCTION-READINESS.md`](./docs/PRODUCTION-READINESS.md). To deploy: **Actions → Deploy production → Run workflow → Review deployments → Approve**.

Production config lives in `wrangler.jsonc` (§31): `workers_dev`/`preview_urls` off, `APP_ACCESS_MODE=access`, custom domain route, observability logs + 5%-sampled traces. No tokens in the repo — deploy credentials are GitHub `production` environment secrets.

---

## 3. API guide

JSON API under `/api/*`, all Access-protected. Every response uses the envelope convention (PRD §38):

- Success: `{ "data": … }` (paginated lists add `"pagination": { total, limit, offset }`, limit ≤ 200)
- Error: `{ "error": { "category", "message", "requestId", "details": [{path, message}] } }` — categories: `validation` 400, `not_found` 404, `authentication_required` 401, `forbidden` 403, `conflict` 409, `rate_limited` 429, `internal`/`upstream_*` 5xx. Build integrations on `category`, never on `message`.

**Authentication.** `APP_ACCESS_MODE` decides the gate: `locked` (default — reject all), `local` (trusts the `X-Dev-Access-Email` header; local dev only), `access` (production — a verified Cloudflare Access JWT). From outside, calls need an Access session (browser cookie) or **Access service-token headers** (`CF-Access-Client-Id` / `CF-Access-Client-Secret` of a token created for this app); Access injects the JWT and the API verifies it against the team JWKS + pinned AUD. Locally, add `-H "X-Dev-Access-Email: you@morabeza.digital"`.

Every mutating call must also send `Origin: https://uptime.morabeza.digital` (matching `APP_ORIGIN`; localhost origins are accepted in local mode only).

### 3.1 Health

| Method & path | Notes |
| --- | --- |
| `GET /healthz` | Anonymous. `200 {"status":"ok"}` or `503 {"status":"degraded"}` — exactly one field. External watchdog target. |

### 3.2 Clients

| Method & path | Notes |
| --- | --- |
| `GET /api/clients` | All clients. |
| `POST /api/clients` | `{ name, slug, notes? }` — slug must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`. |
| `GET /api/clients/:id` · `PATCH /api/clients/:id` | Read / update (partial). |
| `DELETE /api/clients/:id` | **Archive**, never delete — history stays read-only. |

### 3.3 Monitors — create, link to a client, and alert routing (the must-have)

Monitors are fully API-manageable. Creation requires a `clientId` (link to a client) and returns the monitor envelope.

```bash
# 1. Create (or reuse) the client that owns the monitor
curl -X POST https://uptime.morabeza.digital/api/clients \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -H "Origin: https://uptime.morabeza.digital" \
  -d '{"name":"Morabeza Agency","slug":"morabeza-agency"}'

# 2. Create the monitor, linked to that client
curl -X POST https://uptime.morabeza.digital/api/monitors \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -H "Origin: https://uptime.morabeza.digital" \
  -d '{
    "clientId": "cli_xxx",
    "name": "advogados.cv",
    "url": "https://advogados.cv",
    "method": "GET",
    "intervalSeconds": 300,
    "expectedStatusCodes": [200],
    "timeoutMs": 10000,
    "failureThreshold": 3,
    "recoveryThreshold": 2
  }'
```

Accepted fields: `clientId` (required), `name`, `url` (http/https, no private targets), `method` (`GET`/`HEAD`/`POST`), `headers` (sensitive names rejected), `requestBody`, `expectedStatusCodes` (1–20 codes), `bodyContains`/`bodyNotContains` (≤1024), `maxResponseTimeMs`, `intervalSeconds` (60/120/300/600), `timeoutMs` (1000–60000), `failureThreshold`/`recoveryThreshold` (1–10), `cacheBust`, `tags`.

**Alert routing for new monitors:** a target flagged **Default target** (`isDefault: true` on `/api/notification-targets`) automatically receives alerts for every monitor **without explicit associations** — so an API-created monitor alerts to your email with zero extra calls. To attach explicit targets instead (or additionally), use the mappings endpoint in §3.5.

Other monitor endpoints:

| Method & path | Notes |
| --- | --- |
| `GET /api/monitors?includeArchived=false` | Fleet list (search/filters used by the UI). |
| `GET /api/monitors/:id` · `PATCH /api/monitors/:id` | Read / partial update (also `enabled: true|false` to pause/resume). |
| `DELETE /api/monitors/:id` | **Archive** (disables + read-only; never deletes). |
| `POST /api/monitors/:id/check` | Manual check-now — `202`, queued, diagnostic only. |
| `GET /api/monitors/:id/uptime?window=24h\|7d\|30d\|90d` | Uptime percentage + eligible-check counts. |
| `GET /api/monitors/:id/checks?limit=&offset=` | Paginated check history (manual/scheduled, reason, timings). |
| `GET /api/monitors/:id/incidents?limit=&offset=` | That monitor's incidents. |
| `POST /api/monitors/import` | Bulk import — JSON **array** of rows (`client` by name-or-slug, case-insensitive, must already exist + the create-schema fields). Whole-file validation, duplicates skipped and flagged, ≤100 rows per file. |
| `GET /api/monitors/export` | Backup JSON (round-trips into import; sensitive headers stripped). |

Bulk example — the file used for the initial rollout is `import-monitors.local.json` (untracked):

```bash
curl -X POST https://uptime.morabeza.digital/api/monitors/import \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -H "Origin: https://uptime.morabeza.digital" \
  --data-binary @import-monitors.local.json
# → {"summary":{"total":27,"created":27,"duplicates":0,"failed":0},"results":[…]}
```

### 3.4 Notification targets

| Method & path | Notes |
| --- | --- |
| `GET /api/notification-targets` | All targets (name, email, `isDefault`, `enabled`). |
| `POST /api/notification-targets` | `{ name, email, isDefault }` — the **default target receives alerts for monitors without explicit associations**. |
| `GET /api/notification-targets/:id` · `PATCH …/:id` | Read / update (email, `isDefault`, `enabled`). |
| `DELETE /api/notification-targets/:id` | 409 if in use — disable instead. |
| `POST /api/notification-targets/:id/test` | Queued test email through the real pipeline; delivery visible in the log (§3.6). |

### 3.5 Monitor ↔ target mappings

| Method & path | Notes |
| --- | --- |
| `GET /api/monitors/:id/notification-targets` | `{ data: [targetId, …] }`. |
| `PUT /api/monitors/:id/notification-targets` | `{ "targetIds": [...] }` — **full replacement** of that monitor's explicit set; callers must merge (the UI's *Apply to monitors* panel does this per changed monitor). Explicitly mapped monitors bypass the default target. |

### 3.6 Incidents, maintenance, operations

| Method & path | Notes |
| --- | --- |
| `GET /api/incidents?limit=&offset=` | Open-first, paginated. `GET /api/incidents/:id` for the timeline. |
| `GET /api/maintenance` · `POST /api/maintenance` · `GET|PATCH|DELETE /api/maintenance/:id` | Windows: `scopeType: global|client|monitor` (+`scopeId`), `startAt`/`endAt` ms-precision UTC. |
| `GET /api/dashboard` | Overview aggregate: counts, trend, recent recoveries, heartbeat chip, per-monitor rows. |
| `GET /api/system` | Version, heartbeat freshness (scheduler/consumer/rollups), cleanup status. |
| `GET /api/dead-letters` · `PATCH /api/dead-letters/:id` | DLQ inspector; resolve-with-notes. |
| `GET /api/notification-events?limit=&offset=` | Delivery log: type, target, monitor, status, attempts, last error. |

---

## 4. Authoritative specification & project rules

**Read before coding:** [`docs/PRD-SPEC.md`](./docs/PRD-SPEC.md) — V1 architecture, data model, Queue/Cron behavior, state machine, Access configuration, Email integration, UI, security requirements, tests, rollout, watchdog.

- **Fixed V1 architecture:** Cloudflare Access → `uptime.morabeza.digital` → Worker (Hono + React/Vite) → D1 + one Cron + Queue → HTTP checks → state/incidents/history → Cloudflare Email Service.
- **Environment policy:** development is local; only production Cloudflare resources exist. No staging Workers, D1, Queues, or hostnames — ever.
- **No automatic deployment.** Production deploys are human-approved (issues #28/#29); the workflow is dispatch-only with an approval gate.
- **Clean-room rule:** `nanasi-apps/cf-uptime-monitor` may be referenced only for behavior/UX. Never fork or copy its AGPL implementation code.
- **Current operational state** is documented in [`docs/PRODUCTION-READINESS.md`](./docs/PRODUCTION-READINESS.md) and [`docs/HANDOFF.md`](./docs/HANDOFF.md).
