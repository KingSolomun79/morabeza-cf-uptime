# Morabeza CF Uptime — Authoritative PRD & Implementation Specification

**Repository:** `KingSolomun79/morabeza-cf-uptime`  
**Product:** Morabeza CF Uptime  
**Owner:** Morabeza Marketing  
**Status:** Approved implementation specification  
**Target runtime:** Cloudflare-native  
**Environment policy:** Local development + production Cloudflare resources only. **Do not create Cloudflare staging resources.**  
**Production hostname:** `https://uptime.morabeza.digital`  
**Last specification update:** 2026-09-05

---

## 1. Purpose of this document

This file is the single authoritative implementation specification for the first production version of Morabeza CF Uptime.

A coding agent must treat this document as the source of truth unless the repository contains a later explicitly approved decision record that supersedes a section.

Do not silently change architecture, storage, authentication, alerting, state-transition semantics, or resource names. If implementation constraints require a change, document the proposed change before implementing it.

---

# 2. Product objective

Build a Morabeza-owned uptime monitoring application for Morabeza Marketing's websites, Cloudflare-native applications, APIs, and selected client websites.

The product should provide the operational usefulness of tools such as Uptime Kuma while remaining native to Cloudflare and requiring no VPS, Docker host, long-running server, or third-party notification provider for its primary operation.

The application must:

- monitor many websites/endpoints from one control plane;
- support different monitoring intervals without creating multiple Cron Triggers;
- avoid false outage notifications caused by one transient failure;
- maintain historical uptime and response-time data;
- group monitors by Morabeza/client;
- provide incident and maintenance history;
- send DOWN and RECOVERED emails using Cloudflare Email Service;
- protect the private operational UI and API with Cloudflare Access;
- expose one deliberately minimal public health endpoint for an external GitHub Upptime watchdog;
- scale by distributing checks through Cloudflare Queues rather than checking every target inside the Cron invocation;
- be safe against duplicate Queue delivery;
- be clean-room implemented and Morabeza-owned.

---

# 3. Clean-room implementation requirement

## 3.1 Reference project

The following project is a **behavioral and UX reference only**:

- https://github.com/nanasi-apps/cf-uptime-monitor

It is useful as a reference for product ideas such as:

- monitor management;
- dashboard concepts;
- status/history views;
- response-time visualization;
- maintenance windows;
- incident presentation;
- state-change notifications;
- bulk monitor import.

## 3.2 Prohibited reuse

The coding agent must **not**:

- fork that repository;
- copy its source files;
- copy components;
- copy database schema definitions;
- copy tests;
- copy CSS or visual styling;
- copy internal function implementations;
- mechanically translate its source code;
- vendor its source into this repository.

Morabeza CF Uptime must be independently designed and implemented from this specification and public platform documentation.

The reference repository uses AGPL-3.0. Avoid importing AGPL-covered implementation code into this product.

## 3.3 External watchdog reference

Upptime is permitted as a separate external monitoring system later in this specification. It must live in a separate GitHub repository and is not the primary monitoring engine.

---

# 4. Confirmed architectural decisions

These decisions are approved and are not optional for V1.

1. **Everything in the primary monitoring application runs on Cloudflare.**
2. **One Worker application** serves the API and private React UI and also handles Cron and Queue events.
3. **Cloudflare D1** stores configuration, state, check history, incidents, maintenance, notifications, rollups, audit events, and system heartbeats.
4. **Cloudflare Queues** executes monitor checks asynchronously.
5. **One Cron Trigger**, once per minute, schedules due work.
6. The Cron handler does not perform remote monitor checks itself.
7. The same Worker may be both Queue producer and Queue consumer.
8. **Cloudflare Email Service** is the only primary email provider in V1.
9. **Cloudflare Access** protects the private application and private API.
10. There are **no Cloudflare staging resources**. Development and automated tests use local Cloudflare emulation. Only production resources are created remotely.
11. **Cloudflare Workflows are not needed for V1.**
12. No VPS, container, n8n, Supabase, Firebase, external database, Resend, or SMTP2Go is required.
13. A separate tiny GitHub Upptime repository is added only after the production Cloudflare monitor is stable.
14. There is no public status page in the first release. A public status page is a V1.1 feature.

---

# 5. Recommended technology stack

## 5.1 Application

Use:

- TypeScript;
- Cloudflare Workers;
- Hono for the Worker HTTP/API layer;
- React for the admin UI;
- Vite;
- official Cloudflare Vite plugin;
- Cloudflare Workers Static Assets so the frontend and Worker deploy as one unit;
- D1;
- Cloudflare Queues;
- Cloudflare Email Service;
- Cloudflare Access;
- Wrangler;
- Vitest;
- Drizzle ORM for typed D1 access and migration/schema organization;
- Zod for external/input validation;
- TanStack Query for frontend server-state management;
- React Router for frontend routing;
- Tailwind CSS + shadcn/ui for a clean independently implemented admin UI;
- Recharts or an equivalent permissively licensed React charting library for response-time graphs;
- Lucide icons or equivalent permissively licensed icons.

Do not add `nodejs_compat` unless a concrete dependency requires it. Prefer Workers-native APIs.

## 5.2 Initial scaffold

Use the official Cloudflare Hono + React template pattern:

```bash
pnpm create cloudflare@latest morabeza-cf-uptime \
  --template=cloudflare/templates/vite-react-template
```

Because this repository already exists, adapt/scaffold into the existing repo rather than creating a second repository.

Official reference:

- https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/
- https://developers.cloudflare.com/workers/vite-plugin/
- https://developers.cloudflare.com/workers/static-assets/

---

# 6. Production Cloudflare resource model

Only create these remote resources.

| Purpose | Production resource |
|---|---|
| Worker | `morabeza-cf-uptime` |
| D1 | `morabeza-cf-uptime-db` |
| Main Queue | `morabeza-cf-uptime-checks` |
| Dead-letter Queue | `morabeza-cf-uptime-checks-dlq` |
| Custom hostname | `uptime.morabeza.digital` |
| Email binding | `EMAIL` |
| D1 binding | `DB` |
| Queue producer binding | `CHECK_QUEUE` |

Use a Western Europe D1 location hint when the database is first created:

```bash
wrangler d1 create morabeza-cf-uptime-db --location=weur
```

The location hint is a preference, not a hard data-location guarantee.

Create Queues:

```bash
wrangler queues create morabeza-cf-uptime-checks
wrangler queues create morabeza-cf-uptime-checks-dlq
```

Do not create `*-staging` D1 databases, Queues, Workers, or hostnames.

---

# 7. Environment/deployment model

## 7.1 Local development

All pre-production development uses local bindings/emulation through the Cloudflare Vite plugin / Wrangler.

Local development must support:

- local D1 migrations;
- local API/UI development;
- local scheduled-handler invocation;
- local Queue producer/consumer testing where supported by the Cloudflare development runtime;
- mocked Email Service sends in unit/integration tests;
- deterministic test targets for success, failure, timeout, slow response and body assertion behavior.

Never point local automated tests at real client sites unless an explicit integration test is being performed manually.

## 7.2 Production deployment

Production deployment is a human-approved action.

Recommended GitHub Actions model:

### CI workflow

On pull request and push:

- install dependencies;
- lint;
- typecheck;
- unit tests;
- integration tests;
- build.

No Cloudflare deployment.

### Production workflow

Use `workflow_dispatch` and a GitHub `production` environment with required reviewer approval.

Production deploy sequence:

1. verify clean CI;
2. apply reviewed D1 migrations to production;
3. deploy Worker + static assets;
4. run smoke tests;
5. verify `/healthz`;
6. verify Access-protected UI;
7. verify Cron heartbeat;
8. verify Queue heartbeat;
9. send a test email from the admin UI.

Do not automatically deploy production on every merge to `main`.

---

# 8. Cloudflare Access design

## 8.1 Private application

`uptime.morabeza.digital` is an internal Morabeza operational application.

Create a Cloudflare Access self-hosted/public-hostname application protecting:

```text
uptime.morabeza.digital/*
```

Use an Allow policy containing only approved Morabeza operator identities.

Access is deny-by-default; no anonymous user should reach the UI or `/api/*` routes.

The initial operator set can be small. Do not build application-level passwords or a parallel login system.

## 8.2 Public health exception

The external GitHub Upptime watchdog must be able to test the monitoring platform even if the operator is not logged into Access.

Create a more specific Access path/application for:

```text
uptime.morabeza.digital/healthz
```

with a public/Bypass policy.

The more specific Access path must take precedence over the broader private application rule.

**This is the only deliberately public route in V1.**

The public health route must not expose:

- monitor names;
- client names;
- target URLs;
- incident details;
- emails;
- Queue payloads;
- D1 details;
- secrets;
- Access identities.

## 8.3 Prevent bypass routes

Production Wrangler configuration must disable alternate public Worker entry points:

```toml
workers_dev = false
preview_urls = false
```

Serve production through the intended custom domain only.

## 8.4 API defense in depth

For production `/api/*` requests:

- require evidence of an authenticated Access request;
- reject requests missing expected Access identity context;
- store the Access user email in audit events where available;
- for mutating methods, verify the `Origin` matches `https://uptime.morabeza.digital`;
- accept JSON only on JSON mutation routes;
- do not enable permissive CORS.

Do not trust a client-supplied email/username as the audit actor.

---

# 9. Cloudflare Email Service design

## 9.1 Required setup

Morabeza will use Cloudflare Email Service.

Owner action:

1. Cloudflare dashboard → Compute → Email Service → Email Sending.
2. Onboard `morabeza.digital`.
3. Allow Cloudflare to configure the required bounce MX, SPF and DKIM records.
4. Verify the operational destination address(es).

Recommended default sender:

```text
Morabeza Uptime <uptime@morabeza.digital>
```

The sender must be configurable and may be changed by the owner during provisioning.

## 9.2 Worker binding

Configure a Workers Email Service binding:

```json
{
  "send_email": [
    { "name": "EMAIL" }
  ]
}
```

No SMTP credentials or external email API key are required.

## 9.3 Email behavior

Send notification emails only for meaningful state transitions:

- `UP -> DOWN`: send DOWN;
- `DOWN -> UP`: send RECOVERED.

Do not email on every failed check.

Do not send RECOVERED when the monitor has never previously reached DOWN.

Send one email per notification target so delivery and retry state can be tracked independently.

Every send must have a unique notification dedupe key.

## 9.4 Example DOWN subject/body

Subject:

```text
[DOWN] contabilistas.cv — Homepage
```

Body should include:

- client;
- monitor name;
- URL;
- failure reason;
- HTTP status when available;
- response time when available;
- consecutive failure count;
- incident opening time;
- direct link to the Access-protected monitor detail page.

## 9.5 Example RECOVERED subject/body

Subject:

```text
[RECOVERED] contabilistas.cv — Homepage
```

Body should include:

- client;
- monitor;
- recovered time;
- outage duration;
- response time;
- direct incident link.

## 9.6 Email retry model

Do not tightly couple email delivery to the check transaction.

When a state transition occurs:

1. persist incident/state transition;
2. create unique `notification_events` rows;
3. enqueue `notification.send` message(s) to the same main Queue;
4. Queue consumer sends through `EMAIL`;
5. mark notification `sent` or retry on transient failure.

Cloudflare Queues is at-least-once. Notification deduplication is mandatory.

---

# 10. Monitoring model

## 10.1 V1 monitor type

V1 supports HTTP/HTTPS endpoint monitoring.

Supported methods:

- `GET`;
- `HEAD`;
- `POST` for purpose-built idempotent health endpoints only.

The UI must warn that POST monitors may be executed more than once because Queue delivery and network behavior can retry work. Add a unique `X-Morabeza-Uptime-Check-Id` header to each request.

## 10.2 Supported assertions

Per monitor support:

- expected HTTP status codes (one or more);
- required response text (`body_contains`);
- forbidden response text (`body_not_contains`);
- maximum response time;
- request timeout.

A healthy result requires all configured assertions to pass.

## 10.3 Supported intervals

V1 interval choices:

```text
60 seconds
120 seconds
300 seconds
600 seconds
```

Recommended default for ordinary websites: **300 seconds**.

Use 60 or 120 seconds for critical applications only.

Do not create separate Cron Triggers for different intervals.

## 10.4 Default thresholds

Default:

```text
failure_threshold = 3
recovery_threshold = 2
```

Both are configurable per monitor with reasonable bounds.

Recommended bounds:

```text
failure_threshold: 1..10
recovery_threshold: 1..10
```

## 10.5 Timeout

Recommended default:

```text
10 seconds
```

Allowed range:

```text
1..60 seconds
```

## 10.6 Redirects

Follow standard HTTP redirects by default and record the final URL for diagnostics.

## 10.7 Cache behavior

Add an optional `cache_bust` monitor setting.

When enabled:

- send no-cache request headers where applicable;
- add a deterministic uptime query parameter based on the check slot, for example `__morabeza_uptime=...`, unless doing so would break the endpoint.

Use cache busting for application health endpoints. For ordinary public homepage checks it may remain disabled because cached availability can reflect what visitors actually receive.

## 10.8 Body read safety

Do not persist full response bodies.

If body assertions are configured:

- read only a bounded amount of the response body;
- recommended maximum: 256 KiB;
- cancel/stop reading after the bound;
- store only a short sanitized diagnostic excerpt when useful;
- never store credentials or arbitrary full HTML responses in D1.

## 10.9 Custom headers

V1 may support non-sensitive custom request headers.

Do not store obvious secrets in plaintext D1.

Reject or reserve security-sensitive header names in V1, including at least:

- `Authorization`;
- `Proxy-Authorization`;
- `Cookie`;
- `Set-Cookie`;
- generic API-key header patterns that the UI identifies as secret-bearing.

Authenticated private-target monitoring with secret references is a future feature.

---

# 11. Result classification

Each check should produce a primary reason code.

Allowed V1 reason codes:

```text
ok
timeout
network_error
unexpected_status
body_required_text_missing
body_forbidden_text_present
response_too_slow
invalid_response
maintenance
internal_error
```

Store structured assertion details separately where useful.

Do not infer a site's cause beyond what the monitor can observe.

---

# 12. State machine

## 12.1 Monitor status values

Canonical monitor state:

```text
unknown
up
down
paused
```

Maintenance is an overlay, not a permanent monitor state.

## 12.2 Initial state

New or re-enabled monitor:

```text
status = unknown
consecutive_failures = 0
consecutive_successes = 0
```

## 12.3 DOWN transition

Example using threshold 3:

```text
UP
failure #1 -> remain UP
failure #2 -> remain UP
failure #3 -> DOWN
```

On the threshold-crossing check:

- set state to `down`;
- open one incident;
- set incident start time to the timestamp of the first failure in the qualifying consecutive failure sequence if available;
- enqueue DOWN notifications.

## 12.4 RECOVERED transition

Example using recovery threshold 2:

```text
DOWN
success #1 -> remain DOWN
success #2 -> UP
```

On threshold crossing:

- resolve the open incident;
- set state `up`;
- calculate outage duration;
- enqueue RECOVERED notifications.

## 12.5 Unknown behavior

If the first checks succeed, transition `unknown -> up` after the configured recovery threshold or immediately on first success. V1 recommended behavior: **first healthy scheduled check sets `unknown -> up` immediately**, because there is no outage to confirm.

If initial checks fail, require the normal failure threshold before declaring DOWN.

Do not send a RECOVERED email for `unknown -> up`.

## 12.6 Failure/success counters

A successful health evaluation resets consecutive failures to 0.

A failed health evaluation resets consecutive successes to 0.

Only scheduled, non-maintenance checks participate in the state machine.

---

# 13. Manual checks

A user may click **Run check now**.

Manual checks:

- are executed through the Queue;
- use a unique manual check ID;
- are persisted for diagnostic visibility;
- are marked `source = manual`;
- **do not affect uptime percentages**;
- **do not increment failure/recovery counters**;
- **do not open or close incidents**;
- **do not trigger DOWN/RECOVERED notification emails**.

This prevents an operator testing a monitor from altering production uptime statistics.

---

# 14. Maintenance windows

## 14.1 Behavior

Scheduled checks continue to run during maintenance.

During an active maintenance window:

- persist the result;
- flag the result as maintenance-excluded;
- do not update availability counters;
- do not change monitor state;
- do not open/close incidents;
- do not send state-change notifications;
- exclude the check from uptime calculations.

This gives operators visibility into recovery during planned work without corrupting SLA/uptime data.

## 14.2 Scope

V1 maintenance window scopes:

```text
global
client
monitor
```

A global maintenance window affects all monitors.

## 14.3 End of maintenance

The next normal scheduled check resumes standard state evaluation.

Do not synthesize a recovery merely because maintenance ended.

---

# 15. Scheduler design

## 15.1 Cron

Use exactly one production Cron Trigger:

```text
* * * * *
```

Cloudflare Cron runs in UTC.

## 15.2 Cron responsibilities

The scheduled handler must remain lightweight.

Each minute it should:

1. normalize the scheduled time to a minute slot;
2. update the scheduler system heartbeat;
3. query active monitors where `next_check_at <= now`;
4. create deterministic Queue messages for due monitors;
5. enqueue messages in batches;
6. advance `next_check_at` only for work successfully queued;
7. record a scheduler run summary;
8. occasionally enqueue housekeeping jobs based on the current UTC time;
9. return.

The scheduled handler must not perform target HTTP requests.

## 15.3 Missed schedule behavior

Do not backfill every missed historical check after downtime.

If a monitor is overdue, enqueue one current check and schedule the next future check based on its interval.

## 15.4 Deterministic check ID

Scheduled message example:

```json
{
  "type": "monitor.check",
  "monitorId": "mon_123",
  "scheduledFor": "2026-09-05T12:31:00Z",
  "checkId": "mon_123:2026-09-05T12:31:00Z",
  "source": "scheduled",
  "affectsState": true
}
```

Use the deterministic ID as the D1 primary/unique key for the scheduled result.

---

# 16. Queue design

## 16.1 Main Queue

Use:

```text
morabeza-cf-uptime-checks
```

The same Worker acts as producer and consumer.

## 16.2 Queue message types

V1 may use one Queue with typed messages:

```text
monitor.check
notification.send
system.heartbeat
rollup.hourly
rollup.daily
retention.cleanup
```

Every message must have a schema version and unique job/idempotency key.

Example envelope:

```json
{
  "v": 1,
  "type": "monitor.check",
  "jobId": "...",
  "payload": {}
}
```

Validate every message with Zod before processing.

## 16.3 Delivery semantics

Cloudflare Queues uses at-least-once delivery.

Therefore every handler must be idempotent.

Never assume a Queue message executes only once.

## 16.4 Check idempotency

Consumer sequence:

1. validate message;
2. execute HTTP check;
3. attempt to insert result using unique `check_id`;
4. if the result already exists, treat the message as already completed and do not repeat state side effects;
5. if newly inserted, evaluate state using compare-and-set ordering;
6. persist transition/incident/notification intents;
7. enqueue notification jobs after the persistence succeeds.

## 16.5 Out-of-order protection

`monitor_state` must contain:

```text
last_evaluated_scheduled_for
state_version
```

Only a scheduled result newer than `last_evaluated_scheduled_for` may update availability state.

A late older Queue message may be stored for history but must not roll monitor state backwards.

## 16.6 Dead-letter Queue

Use:

```text
morabeza-cf-uptime-checks-dlq
```

Configure a finite retry count on the main consumer and route exhausted messages to the DLQ.

Persist DLQ visibility in the application before acknowledging DLQ items if a DLQ consumer is implemented.

V1 must at minimum expose operator documentation for inspecting the DLQ. Preferred implementation: the same Worker consumes the DLQ, writes a `dead_letter_events` row, then acknowledges the message. Avoid recursive alert loops when Email Service itself is the failing job.

---

# 17. D1 data model

Use UTC ISO timestamps or integer Unix milliseconds consistently. Do not mix formats unpredictably.

Use text UUID/ULID identifiers for entity IDs unless a strong implementation reason favors integer IDs.

## 17.1 `clients`

Purpose: group monitors by Morabeza/client.

Fields:

```text
id TEXT PRIMARY KEY
name TEXT NOT NULL
slug TEXT NOT NULL UNIQUE
active INTEGER NOT NULL DEFAULT 1
notes TEXT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
archived_at TEXT NULL
```

Indexes:

```text
slug
active
```

A `Morabeza` client/group should be seeded for internal sites.

## 17.2 `monitors`

```text
id TEXT PRIMARY KEY
client_id TEXT NOT NULL REFERENCES clients(id)
name TEXT NOT NULL
url TEXT NOT NULL
method TEXT NOT NULL DEFAULT 'GET'
headers_json TEXT NULL
request_body TEXT NULL
expected_status_codes_json TEXT NOT NULL DEFAULT '[200]'
body_contains TEXT NULL
body_not_contains TEXT NULL
max_response_time_ms INTEGER NULL
interval_seconds INTEGER NOT NULL DEFAULT 300
timeout_ms INTEGER NOT NULL DEFAULT 10000
failure_threshold INTEGER NOT NULL DEFAULT 3
recovery_threshold INTEGER NOT NULL DEFAULT 2
cache_bust INTEGER NOT NULL DEFAULT 0
enabled INTEGER NOT NULL DEFAULT 1
next_check_at TEXT NOT NULL
tags_json TEXT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
archived_at TEXT NULL
```

Recommended uniqueness policy:

- do not globally require URL uniqueness;
- the same URL may be monitored with different assertions;
- bulk import should warn on probable duplicate `client + url + method` combinations.

Indexes:

```text
(client_id)
(enabled, next_check_at)
(archived_at)
```

## 17.3 `monitor_state`

One row per monitor.

```text
monitor_id TEXT PRIMARY KEY REFERENCES monitors(id)
status TEXT NOT NULL DEFAULT 'unknown'
consecutive_failures INTEGER NOT NULL DEFAULT 0
consecutive_successes INTEGER NOT NULL DEFAULT 0
failure_sequence_started_at TEXT NULL
last_evaluated_scheduled_for TEXT NULL
last_checked_at TEXT NULL
last_success_at TEXT NULL
last_failure_at TEXT NULL
last_status_code INTEGER NULL
last_response_time_ms INTEGER NULL
last_reason_code TEXT NULL
open_incident_id TEXT NULL
state_version INTEGER NOT NULL DEFAULT 0
updated_at TEXT NOT NULL
```

## 17.4 `check_results`

```text
id TEXT PRIMARY KEY                  -- checkId
monitor_id TEXT NOT NULL REFERENCES monitors(id)
source TEXT NOT NULL                 -- scheduled|manual
scheduled_for TEXT NULL
started_at TEXT NOT NULL
completed_at TEXT NOT NULL
is_healthy INTEGER NOT NULL
maintenance_excluded INTEGER NOT NULL DEFAULT 0
affects_state INTEGER NOT NULL DEFAULT 0
status_code INTEGER NULL
response_time_ms INTEGER NULL
final_url TEXT NULL
reason_code TEXT NOT NULL
error_message TEXT NULL
assertions_json TEXT NULL
created_at TEXT NOT NULL
```

Indexes:

```text
(monitor_id, completed_at DESC)
(completed_at)
(source, completed_at)
```

Never store full response bodies.

## 17.5 `incidents`

```text
id TEXT PRIMARY KEY
monitor_id TEXT NOT NULL REFERENCES monitors(id)
status TEXT NOT NULL                 -- open|resolved|closed_admin
opened_at TEXT NOT NULL
first_failure_at TEXT NOT NULL
resolved_at TEXT NULL
trigger_check_id TEXT NULL
recovery_check_id TEXT NULL
open_reason_code TEXT NULL
outage_duration_ms INTEGER NULL
resolution_reason TEXT NULL          -- recovered|monitor_disabled|admin
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Enforce at most one open incident per monitor at the application/repository layer and with an appropriate partial unique index if supported cleanly by the chosen migration approach.

## 17.6 `maintenance_windows`

```text
id TEXT PRIMARY KEY
title TEXT NOT NULL
description TEXT NULL
scope_type TEXT NOT NULL             -- global|client|monitor
scope_id TEXT NULL
starts_at TEXT NOT NULL
ends_at TEXT NOT NULL
created_by TEXT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
cancelled_at TEXT NULL
```

Validate:

- `global` => `scope_id` is null;
- `client` => valid client id;
- `monitor` => valid monitor id;
- `ends_at > starts_at`.

## 17.7 `notification_targets`

```text
id TEXT PRIMARY KEY
name TEXT NOT NULL
email TEXT NOT NULL UNIQUE
enabled INTEGER NOT NULL DEFAULT 1
is_default INTEGER NOT NULL DEFAULT 0
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Email addresses are not secrets.

## 17.8 `monitor_notification_targets`

```text
monitor_id TEXT NOT NULL REFERENCES monitors(id)
target_id TEXT NOT NULL REFERENCES notification_targets(id)
PRIMARY KEY (monitor_id, target_id)
```

If a monitor has no explicit target mapping, use enabled targets with `is_default = 1`.

## 17.9 `notification_events`

```text
id TEXT PRIMARY KEY
dedupe_key TEXT NOT NULL UNIQUE
monitor_id TEXT NOT NULL REFERENCES monitors(id)
incident_id TEXT NULL REFERENCES incidents(id)
target_id TEXT NOT NULL REFERENCES notification_targets(id)
type TEXT NOT NULL                   -- down|recovered|test
status TEXT NOT NULL                 -- pending|sending|sent|failed
attempts INTEGER NOT NULL DEFAULT 0
provider_message_id TEXT NULL
last_error TEXT NULL
created_at TEXT NOT NULL
sent_at TEXT NULL
updated_at TEXT NOT NULL
```

Dedupe pattern:

```text
{incident_id}:{type}:{target_id}
```

## 17.10 `hourly_rollups`

```text
monitor_id TEXT NOT NULL
hour_start TEXT NOT NULL
eligible_checks INTEGER NOT NULL
up_checks INTEGER NOT NULL
down_checks INTEGER NOT NULL
avg_response_time_ms REAL NULL
min_response_time_ms INTEGER NULL
max_response_time_ms INTEGER NULL
PRIMARY KEY (monitor_id, hour_start)
```

Exclude manual and maintenance-excluded checks.

## 17.11 `daily_rollups`

Same concept at day level:

```text
monitor_id TEXT NOT NULL
day_start TEXT NOT NULL
eligible_checks INTEGER NOT NULL
up_checks INTEGER NOT NULL
down_checks INTEGER NOT NULL
avg_response_time_ms REAL NULL
min_response_time_ms INTEGER NULL
max_response_time_ms INTEGER NULL
incident_count INTEGER NOT NULL DEFAULT 0
downtime_ms INTEGER NOT NULL DEFAULT 0
PRIMARY KEY (monitor_id, day_start)
```

## 17.12 `scheduler_runs`

```text
id TEXT PRIMARY KEY
scheduled_at TEXT NOT NULL
due_monitor_count INTEGER NOT NULL
enqueued_count INTEGER NOT NULL
failed_batch_count INTEGER NOT NULL DEFAULT 0
duration_ms INTEGER NOT NULL
error_message TEXT NULL
created_at TEXT NOT NULL
```

Keep this table short-retention.

## 17.13 `system_state`

Single-row system heartbeat/config projection.

```text
id TEXT PRIMARY KEY                  -- use 'system'
last_scheduler_at TEXT NULL
last_queue_consumer_at TEXT NULL
last_hourly_rollup_at TEXT NULL
last_daily_rollup_at TEXT NULL
last_cleanup_at TEXT NULL
updated_at TEXT NOT NULL
```

## 17.14 `audit_events`

```text
id TEXT PRIMARY KEY
actor_email TEXT NULL
action TEXT NOT NULL
entity_type TEXT NOT NULL
entity_id TEXT NULL
summary TEXT NULL
metadata_json TEXT NULL
created_at TEXT NOT NULL
```

Record admin mutations, not every read.

Do not put sensitive request bodies or secret headers in audit metadata.

## 17.15 `dead_letter_events`

Preferred V1:

```text
id TEXT PRIMARY KEY
original_job_id TEXT NULL
message_type TEXT NULL
payload_summary_json TEXT NULL
failure_reason TEXT NULL
received_at TEXT NOT NULL
resolved_at TEXT NULL
resolution_notes TEXT NULL
```

Do not persist credentials or full sensitive payloads.

---

# 18. Retention and aggregation

Raw checks grow quickly.

Default retention:

```text
check_results raw scheduled history: 7 days
scheduler_runs: 7 days
hourly_rollups: 90 days
daily_rollups: 730 days
incidents: retain
maintenance_windows: retain
notification_events: retain at least 365 days
audit_events: retain at least 365 days
dead_letter_events: retain until resolved + operational retention policy
```

Make retention durations configurable as non-secret production vars.

The once-per-minute Cron may enqueue housekeeping jobs; do not create additional Cron Triggers.

Suggested schedule logic inside the existing Cron:

- minute `05`: enqueue previous-hour rollup if not already completed;
- shortly after 00:00 UTC: enqueue previous-day rollup;
- once per UTC day: enqueue retention cleanup;
- every 5 minutes: enqueue a system Queue heartbeat job.

Every housekeeping job must have a deterministic job ID to prevent duplicate execution.

---

# 19. Public `/healthz` design

The route is intentionally public for independent external monitoring.

Return only:

```json
{
  "status": "ok"
}
```

or:

```json
{
  "status": "degraded"
}
```

Status `200` when healthy; `503` when the monitoring control plane is degraded.

The health calculation should verify at minimum:

1. D1 can execute a lightweight query;
2. `last_scheduler_at` is fresh (recommended <= 3 minutes old after bootstrapping);
3. `last_queue_consumer_at` is fresh (recommended <= 10 minutes old, maintained by real jobs and a periodic synthetic queue heartbeat).

Do not call Email Service from `/healthz`.

Headers:

```text
Cache-Control: no-store
Content-Type: application/json
```

Do not include version hashes, internal resource IDs or timestamps unless there is a clear operational need. Minimal is safer.

---

# 20. HTTP checker implementation requirements

For every monitor check:

1. load current monitor configuration from D1 rather than trusting the Queue payload;
2. reject if monitor is archived;
3. for scheduled work, reject/no-op if disabled;
4. build validated URL;
5. apply allowed custom headers;
6. add an identifying User-Agent where the Workers runtime allows it;
7. add `X-Morabeza-Uptime-Check-Id`;
8. optionally apply cache-busting behavior;
9. start high-resolution timer where available;
10. execute `fetch()` with an AbortController/timeout;
11. capture status/final URL/response time;
12. read bounded body only when body assertions are configured;
13. evaluate all assertions;
14. classify result with a stable reason code;
15. persist sanitized diagnostics only.

Recommended User-Agent value:

```text
Morabeza-CF-Uptime/1.0 (+https://uptime.morabeza.digital)
```

Do not automatically retry the outbound target HTTP request inside one check. The scheduled state thresholds already handle transient target failures, and hidden retries would distort response-time and failure semantics.

---

# 21. URL and SSRF safety

Even though admin access is private, monitor URLs are untrusted input.

V1 must:

- allow only `http:` and `https:` schemes;
- reject URLs containing embedded username/password credentials;
- reject localhost/loopback hostnames and IP literals;
- reject link-local and obvious private/reserved IP literals;
- reject malformed URLs;
- normalize URLs before saving;
- cap URL length;
- cap request-header and request-body size;
- never evaluate arbitrary JavaScript supplied by a monitor.

Do not add browser automation to V1.

---

# 22. Monitor create/edit validation

Required:

```text
client
name
URL
method
interval
expected status code(s)
timeout
failure threshold
recovery threshold
```

Rules:

- expected statuses must be valid HTTP status integers;
- interval must match supported values;
- timeout 1..60s;
- failure/recovery threshold 1..10;
- `max_response_time_ms`, if present, must be > 0;
- headers must be a JSON object of string values;
- sensitive header names are rejected;
- POST body size is bounded;
- `body_contains` and `body_not_contains` lengths are bounded;
- body assertions are case-sensitive in V1 unless a future field explicitly changes that behavior.

---

# 23. Monitor disable/archive behavior

## Disable/pause

When a monitor is disabled:

- scheduler stops enqueueing checks;
- state becomes `paused`;
- consecutive counters reset;
- if an incident is open, close it with `resolution_reason = monitor_disabled`;
- do **not** send a RECOVERED notification because the site was not observed recovering.

When re-enabled:

- state becomes `unknown`;
- counters reset;
- `next_check_at = now` so it is checked promptly.

## Archive

Do not hard-delete monitor history in normal UI flows.

Archiving:

- disables monitor;
- sets `archived_at`;
- removes it from default lists;
- preserves checks/incidents/history.

---

# 24. API surface

All routes below except `/healthz` are Access-protected.

Use JSON responses and consistent error envelopes.

Recommended V1 routes:

```text
GET    /healthz

GET    /api/dashboard
GET    /api/system

GET    /api/clients
POST   /api/clients
GET    /api/clients/:id
PATCH  /api/clients/:id
DELETE /api/clients/:id              # archive

GET    /api/monitors
POST   /api/monitors
GET    /api/monitors/:id
PATCH  /api/monitors/:id
DELETE /api/monitors/:id             # archive
POST   /api/monitors/:id/check       # manual diagnostic
POST   /api/monitors/import
GET    /api/monitors/export

GET    /api/monitors/:id/checks
GET    /api/monitors/:id/uptime
GET    /api/monitors/:id/incidents

GET    /api/incidents
GET    /api/incidents/:id

GET    /api/maintenance
POST   /api/maintenance
PATCH  /api/maintenance/:id
DELETE /api/maintenance/:id          # cancel, do not hard delete

GET    /api/notification-targets
POST   /api/notification-targets
PATCH  /api/notification-targets/:id
DELETE /api/notification-targets/:id
POST   /api/notification-targets/:id/test

GET    /api/dead-letters
PATCH  /api/dead-letters/:id
```

Use pagination for histories and list endpoints that can grow large.

Do not expose raw D1 query interfaces.

---

# 25. Bulk import/export

## 25.1 Import

Support JSON import.

Canonical example:

```json
[
  {
    "client": "Morabeza",
    "name": "Contabilistas.cv Homepage",
    "url": "https://contabilistas.cv/",
    "method": "GET",
    "intervalSeconds": 300,
    "expectedStatusCodes": [200],
    "failureThreshold": 3,
    "recoveryThreshold": 2
  }
]
```

Import must:

- validate the complete file before committing where practical;
- report row-level validation failures;
- detect probable duplicates;
- never accept secrets embedded in sensitive headers;
- create an audit event;
- not trigger mass immediate checks in one request handler.

After import, due monitors are picked up by the scheduler/Queue.

## 25.2 Export

Provide JSON export of monitor configuration excluding any future secret values.

This is useful for operational backup/review and moving configurations.

---

# 26. Uptime calculations

Eligible checks are:

```text
source = scheduled
AND maintenance_excluded = false
AND affects_state = true
```

Manual checks never count.

Uptime for a period:

```text
healthy eligible checks / total eligible checks * 100
```

For time ranges that exceed raw retention, use hourly/daily rollups.

Display at least:

```text
24 hours
7 days
30 days
90 days
```

If no eligible data exists, display `No data`, not `100%`.

Do not count paused periods as failures.

---

# 27. Admin UI/UX

The UI should take conceptual inspiration from modern uptime dashboards but must be independently designed.

## 27.1 Visual direction

- clean professional operational dashboard;
- responsive desktop-first layout;
- dark and light theme optional but desirable in V1;
- accessible contrast;
- status colors used consistently;
- do not rely on color alone; always include text/icon labels;
- quick scanning is more important than decorative design;
- avoid dense tables without filters;
- no pixel-for-pixel replication of Nanasi or Uptime Kuma.

Canonical status labels:

```text
UP
DOWN
UNKNOWN
PAUSED
MAINTENANCE
```

## 27.2 Navigation

Recommended sidebar:

```text
Overview
Monitors
Clients
Incidents
Maintenance
Notifications
Import / Export
System
```

## 27.3 Overview/dashboard

Show:

- total active monitors;
- Up count;
- Down count;
- Unknown count;
- Paused count;
- currently in maintenance count;
- open incidents;
- recent recoveries;
- recent average response-time trend;
- latest system heartbeat state.

Primary table/cards:

```text
Client | Monitor | Status | 24h uptime | Last response | Last check | Incident
```

Filters:

```text
client
status
text search
```

## 27.4 Monitors list

Actions:

- create;
- edit;
- duplicate configuration;
- run check now;
- pause/resume;
- archive;
- filter/search;
- bulk import.

Do not allow a destructive permanent delete through the normal UI.

## 27.5 Monitor detail

Display:

- current state;
- client;
- target URL;
- assertions;
- interval;
- failure/recovery threshold;
- last check;
- last response time;
- 24h / 7d / 30d / 90d uptime;
- response-time chart;
- recent checks;
- incidents;
- maintenance overlays;
- notification targets;
- manual check action.

Recent check rows should show:

```text
time | result | HTTP status | response ms | reason | scheduled/manual | maintenance
```

## 27.6 Clients

Client detail should summarize:

- number of monitors;
- Up/Down/Paused counts;
- open incidents;
- aggregate uptime indicators;
- monitors belonging to the client.

No client login/accounts in V1.

## 27.7 Incidents

Show open first, then resolved.

Incident detail:

- monitor;
- client;
- first failure;
- threshold-crossing check;
- open reason;
- recovery;
- duration;
- related check timeline.

## 27.8 Maintenance

Create/edit/cancel maintenance window.

Fields:

- title;
- description;
- scope;
- starts at;
- ends at.

Times displayed to Morabeza operators should default to `Atlantic/Cape_Verde` in the UI, while persisted timestamps remain UTC.

## 27.9 Notifications

Manage verified operational recipient records and monitor associations.

Provide a **Send test email** action.

Clearly show send failure state/history.

## 27.10 System page

Show:

- Worker application status;
- D1 health;
- scheduler last heartbeat;
- queue consumer last heartbeat;
- raw retention policy;
- last hourly rollup;
- last daily rollup;
- last cleanup;
- unresolved dead-letter events;
- application build/version metadata for authenticated users only;
- Email Service test action.

Do not expose Cloudflare account IDs/tokens/secrets.

---

# 28. Observability

Use Cloudflare Workers Logs.

Enable structured logs for:

- scheduler start/completion;
- Queue batch start/completion;
- check completion summaries;
- state transitions;
- incident open/resolve;
- notification send success/failure;
- DLQ events;
- retention/rollup jobs;
- API mutation audit correlation IDs.

Never log:

- Access JWTs;
- cookies;
- full response bodies;
- secret headers;
- email body content unnecessarily;
- request bodies that could contain sensitive data.

Recommended structured fields:

```text
event
requestId/jobId
monitorId
clientId
checkId
incidentId
notificationId
reasonCode
durationMs
outcome
```

Native Workers tracing may be enabled with a conservative sampling rate. Do not require an external OpenTelemetry vendor for V1.

---

# 29. Security requirements

1. Cloudflare Access protects all private routes.
2. `/healthz` is the only anonymous route.
3. `workers_dev` disabled in production.
4. preview URLs disabled in production.
5. No secrets committed to Git.
6. No raw authentication headers stored in D1.
7. Input validation through Zod.
8. Prepared D1 queries / ORM parameter binding only.
9. Origin check for private mutating requests.
10. Same-origin frontend/API; no permissive CORS.
11. Content Security Policy appropriate for the React app.
12. `X-Content-Type-Options: nosniff`.
13. sensible `Referrer-Policy`.
14. frame protection through CSP `frame-ancestors`.
15. Sanitize all user-visible error text.
16. Bound body/header/import sizes.
17. Archive instead of destructive monitor deletion.
18. Audit admin mutations.
19. Do not allow arbitrary JavaScript or shell commands in monitors.
20. Do not allow monitor configuration to access local/private addresses by obvious literal/hostname forms.

---

# 30. Suggested project structure

```text
morabeza-cf-uptime/
  docs/
    PRD-SPEC.md
    adr/
      0001-clean-room.md
      0002-single-worker.md
      0003-queue-monitor-execution.md

  worker/
    index.ts
    env.ts
    app.ts

    routes/
      health.ts
      dashboard.ts
      clients.ts
      monitors.ts
      incidents.ts
      maintenance.ts
      notifications.ts
      system.ts
      import-export.ts

    queue/
      consumer.ts
      schemas.ts
      handlers/
        monitor-check.ts
        notification-send.ts
        system-heartbeat.ts
        hourly-rollup.ts
        daily-rollup.ts
        retention-cleanup.ts

    scheduled/
      scheduler.ts

    services/
      checker.ts
      state-machine.ts
      incidents.ts
      maintenance.ts
      email.ts
      uptime.ts
      system-health.ts
      audit.ts

    repositories/
      clients.ts
      monitors.ts
      checks.ts
      incidents.ts
      maintenance.ts
      notifications.ts
      rollups.ts
      system.ts
      audit.ts

    lib/
      ids.ts
      time.ts
      validation.ts
      errors.ts
      logging.ts
      access.ts
      url-safety.ts

  src/                         # React application
    app/
    pages/
    components/
    features/
      dashboard/
      monitors/
      clients/
      incidents/
      maintenance/
      notifications/
      system/
    lib/
      api.ts
      query-client.ts
      time.ts

  db/
    schema.ts
    migrations/

  tests/
    unit/
    integration/
    fixtures/

  public/
  package.json
  vite.config.ts
  wrangler.jsonc
  tsconfig.json
```

Exact folder names may adapt to the official template, but keep concerns separated.

---

# 31. Production Wrangler configuration requirements

The final production configuration must include the conceptual equivalent of:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "morabeza-cf-uptime",
  "main": "worker/index.ts",
  "compatibility_date": "2026-09-05",
  "workers_dev": false,
  "preview_urls": false,
  "triggers": {
    "crons": ["* * * * *"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "morabeza-cf-uptime-db",
      "database_id": "OWNER_TO_FILL_AFTER_CREATION",
      "migrations_dir": "db/migrations"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "CHECK_QUEUE",
        "queue": "morabeza-cf-uptime-checks"
      }
    ],
    "consumers": [
      {
        "queue": "morabeza-cf-uptime-checks",
        "dead_letter_queue": "morabeza-cf-uptime-checks-dlq",
        "max_retries": 3
      },
      {
        "queue": "morabeza-cf-uptime-checks-dlq"
      }
    ]
  },
  "send_email": [
    {
      "name": "EMAIL"
    }
  ],
  "vars": {
    "APP_ORIGIN": "https://uptime.morabeza.digital",
    "APP_TIMEZONE": "Atlantic/Cape_Verde",
    "DEFAULT_FROM_EMAIL": "uptime@morabeza.digital",
    "RAW_CHECK_RETENTION_DAYS": "7",
    "HOURLY_RETENTION_DAYS": "90",
    "DAILY_RETENTION_DAYS": "730"
  },
  "observability": {
    "logs": {
      "enabled": true
    },
    "traces": {
      "enabled": true,
      "head_sampling_rate": 0.05
    }
  }
}
```

This is an architectural example. The coding agent must align final syntax with the installed current Wrangler schema and Cloudflare Vite plugin output rather than blindly copying this example.

No API tokens belong in `wrangler.jsonc`.

---

# 32. Testing strategy

Testing is a release requirement, not optional polish.

## 32.1 Unit tests

At minimum test:

### URL safety

- valid HTTPS;
- valid HTTP;
- malformed URL rejected;
- `localhost` rejected;
- loopback IP rejected;
- private IP literal rejected;
- embedded credentials rejected.

### Checker

- HTTP 200 success;
- accepted non-200 status configured as healthy;
- unexpected status;
- timeout;
- network error;
- body contains success/failure;
- body-not-contains success/failure;
- max response time failure;
- bounded body processing;
- no response body persisted.

### State machine

- unknown -> up;
- unknown failures do not declare DOWN before threshold;
- third failure declares DOWN with default threshold;
- continued failure does not create second incident;
- first success while DOWN does not recover with threshold 2;
- second success recovers;
- counters reset correctly;
- out-of-order result cannot roll state backwards;
- paused monitor does not transition;
- maintenance result does not transition;
- manual result does not transition.

### Notifications

- DOWN notification only once per target/incident;
- RECOVERED notification only once;
- duplicate Queue message cannot duplicate email event;
- send failure updates attempts/error;
- test notification works independently of incidents.

### Uptime calculations

- manual checks excluded;
- maintenance checks excluded;
- paused/no-data handled correctly;
- rollup and raw periods agree for deterministic fixtures.

## 32.2 Integration tests

Use deterministic test Worker/routes or local fixtures for:

- healthy endpoint;
- 500 endpoint;
- delayed endpoint;
- body assertion endpoint;
- redirect endpoint;
- oversized-body endpoint.

Test local scheduled handler through the official local scheduled route where supported.

Test Queue duplicate behavior by deliberately sending the same job twice.

## 32.3 Production smoke tests

Before declaring production ready:

1. `/healthz` returns 200 and minimal JSON;
2. anonymous request to `/` is blocked/challenged by Access;
3. authorized operator reaches UI;
4. anonymous request to `/api/monitors` is blocked;
5. create client;
6. create healthy monitor;
7. scheduled check reaches Queue and D1;
8. manual check appears but does not affect uptime;
9. controlled failure reaches threshold and opens exactly one incident;
10. exactly one DOWN email per target;
11. controlled recovery resolves incident after threshold;
12. exactly one RECOVERED email per target;
13. maintenance suppresses state transition/notifications;
14. duplicate Queue job creates no duplicate side effects;
15. system page shows fresh Cron and Queue heartbeats.

---

# 33. Seed data

Initial seed after migration:

## Client

```text
Name: Morabeza
Slug: morabeza
```

Do not seed real production monitors in migration SQL.

Add them through the admin UI/import after the monitoring engine passes smoke testing.

Initial candidate monitors may later include:

- `morabeza.digital`;
- `contabilistas.cv`;
- `advogados.cv`;
- other Morabeza properties;
- important application `/healthz` endpoints.

---

# 34. Implementation phases

## Phase 0 — Repository and clean-room foundation

Deliver:

- application scaffold;
- package manager lockfile;
- CI;
- lint/typecheck/test scripts;
- ADRs for clean-room, single Worker and Queue execution;
- no production resource creation yet.

Acceptance:

- local app boots;
- test suite runs;
- build succeeds.

## Phase 1 — D1 domain model

Deliver:

- schema;
- migrations;
- repository layer;
- client/monitor CRUD API;
- validation;
- local tests.

Acceptance:

- local migrations up/down strategy documented;
- monitor validation tests pass;
- no monitor history is hard-deleted through standard APIs.

## Phase 2 — Check engine

Deliver:

- HTTP checker;
- assertion engine;
- safe timeouts;
- body bounds;
- reason codes;
- local deterministic integration targets/tests.

Acceptance:

- success, failure, timeout, body and latency cases pass.

## Phase 3 — Scheduler + Queue

Deliver:

- one-minute scheduled handler;
- due-monitor selection;
- main Queue producer;
- Queue consumer;
- deterministic IDs;
- duplicate protection;
- system heartbeat jobs;
- DLQ handling.

Acceptance:

- repeated same Queue job cannot duplicate result/side effects;
- Cron performs no target fetches;
- intervals 60/120/300/600 work from one Cron.

## Phase 4 — State machine + incidents

Deliver:

- monitor state;
- thresholds;
- out-of-order protection;
- incidents;
- pause/re-enable semantics;
- manual-check semantics;
- maintenance semantics.

Acceptance:

- state-machine test matrix passes.

## Phase 5 — Cloudflare Email Service

Deliver:

- notification targets;
- notification event dedupe;
- email Queue jobs;
- DOWN/RECOVERED/test templates;
- retry state.

Acceptance:

- duplicate check cannot duplicate emails;
- one transition produces one email per target.

## Phase 6 — Rollups and retention

Deliver:

- hourly rollup;
- daily rollup;
- retention cleanup;
- uptime calculations;
- deterministic housekeeping job IDs.

Acceptance:

- 24h/7d/30d/90d queries work;
- manual/maintenance results excluded.

## Phase 7 — Operational UI

Deliver:

- Overview;
- Monitors;
- Clients;
- Monitor detail;
- Incidents;
- Maintenance;
- Notifications;
- import/export;
- System page;
- responsive UI.

Acceptance:

- all core operations possible without direct D1 access.

## Phase 8 — Production Cloudflare provisioning

This is the first remote Cloudflare resource phase.

Owner/admin actions:

1. onboard `morabeza.digital` to Cloudflare Email Service;
2. verify alert recipient(s);
3. create Access applications/policies including `/healthz` exception;
4. create production D1;
5. create main Queue;
6. create DLQ;
7. populate D1 database ID in production configuration;
8. configure GitHub production deployment secrets/token with least privilege;
9. apply production migrations;
10. deploy Worker/custom domain;
11. run production smoke gate.

No staging resource is created.

## Phase 9 — Initial monitor rollout

Roll out gradually:

1. 3–5 Morabeza monitors;
2. observe at least one controlled failure/recovery test;
3. validate false-positive behavior;
4. import remaining Morabeza sites;
5. add client sites in batches.

Do not import hundreds of monitors before alert/state logic has been observed in production.

## Phase 10 — External Upptime watchdog

After the Cloudflare application is stable, create a separate GitHub repository, recommended name:

```text
KingSolomun79/morabeza-uptime-watchdog
```

Use Upptime only for a small set of external checks, initially:

- `https://uptime.morabeza.digital/healthz`;
- `https://morabeza.digital/`;
- critical payment endpoint if applicable;
- one or more critical business applications.

Purpose:

> Detect failure of Cloudflare/Morabeza CF Uptime from an execution environment outside Cloudflare.

Do not duplicate all internal monitors in Upptime.

---

# 35. Production owner-action checklist

The coding agent must not invent these values.

```text
[ ] Confirm Access operator email(s)/identity rule
[ ] Onboard morabeza.digital in Cloudflare Email Service
[ ] Confirm sender address (recommended uptime@morabeza.digital)
[ ] Verify destination alert address(es)
[ ] Create morabeza-cf-uptime-db (weur hint)
[ ] Create morabeza-cf-uptime-checks
[ ] Create morabeza-cf-uptime-checks-dlq
[ ] Configure Access for uptime.morabeza.digital/*
[ ] Configure public Access bypass for exact /healthz
[ ] Confirm custom hostname uptime.morabeza.digital
[ ] Configure least-privilege Cloudflare deploy credentials in GitHub production environment
[ ] Approve first production D1 migration
[ ] Approve first production deployment
```

All other implementation work should be possible locally before this checklist is completed.

---

# 36. Performance and scaling requirements

V1 should comfortably support at least hundreds of monitors without architectural redesign.

Rules:

- never execute all monitors inside one Cron invocation;
- paginate/query only due monitors;
- enqueue in batches;
- let Queue consumers scale horizontally;
- keep each check independent;
- index `enabled + next_check_at`;
- avoid N+1 history queries on dashboard;
- use aggregated dashboard queries;
- paginate check history;
- use rollups for long periods;
- cap response body reads;
- do not persist unnecessary payloads.

Example load awareness:

```text
100 monitors @ 1 minute = 144,000 scheduled checks/day
100 monitors @ 5 minutes = 28,800 scheduled checks/day
```

Architecture must not assume a small fixed monitor count.

---

# 37. Reliability requirements

1. Queue duplicate delivery does not duplicate check result side effects.
2. Duplicate state-transition execution does not create duplicate incidents.
3. Duplicate notification jobs do not duplicate emails.
4. Out-of-order checks do not roll state backwards.
5. Email failure does not roll back a valid monitor state transition.
6. D1 failure causes the Queue job to retry rather than silently dropping state.
7. Scheduler enqueue failure leaves work due for a future scheduler pass.
8. Housekeeping failure does not block monitor scheduling.
9. A failing single monitor does not fail the entire Queue batch.
10. Public `/healthz` becomes degraded if scheduler/Queue heartbeats become stale.

---

# 38. Error handling

Classify internal errors into stable categories:

```text
validation
not_found
conflict
authentication_required
forbidden
rate_limited
upstream_timeout
upstream_failure
database_failure
queue_failure
email_failure
internal
```

API responses must not leak stack traces in production.

Worker logs may contain structured internal errors but not secrets.

Use correlation/request IDs for API requests and Queue jobs.

---

# 39. Non-goals for V1

Do not build these before V1 acceptance unless a later approved decision explicitly moves them forward:

- public customer status page;
- customer accounts/logins;
- per-client Access policies;
- SMS alerts;
- WhatsApp alerts;
- Slack/Discord alerts;
- phone calls;
- Browser Rendering checks;
- synthetic login journeys;
- TCP/UDP checks;
- ICMP ping;
- DNS monitoring;
- SSL certificate-expiry monitoring;
- domain-expiry monitoring;
- multi-region probe consensus;
- external observability vendor requirement;
- AI diagnosis;
- automated remediation;
- Cloudflare Workflows;
- R2;
- third-party email providers;
- encrypted per-monitor API credentials;
- secret-bearing authenticated monitor headers.

---

# 40. V1.1 candidates

After V1 is stable, consider:

1. `status.morabeza.digital` public status page;
2. public components/groups;
3. manual incident announcements;
4. SSL certificate expiry;
5. domain expiry where a reliable data source exists;
6. authenticated private health checks using secure secret references;
7. Discord notifications;
8. richer JSON-path health assertions;
9. warning/degraded response-time threshold distinct from DOWN;
10. external second-probe support;
11. service dependency relationships;
12. acknowledgement/escalation workflows;
13. client-facing read-only status views;
14. webhook notifications;
15. API integration with Morabeza OS.

---

# 41. Release acceptance criteria

V1 is production-ready only when all of the following are true.

## Architecture

- [ ] One Worker app handles fetch/scheduled/queue events.
- [ ] One production Cron Trigger only.
- [ ] D1 is canonical state store.
- [ ] Queue executes checks.
- [ ] Main Queue has DLQ.
- [ ] No remote staging resources exist.

## Access/security

- [ ] UI/API inaccessible anonymously.
- [ ] `/healthz` is public and minimal.
- [ ] `workers.dev` is disabled.
- [ ] preview URLs are disabled.
- [ ] no secrets committed.
- [ ] sensitive monitor headers rejected in V1.
- [ ] mutation audit events stored.

## Monitoring

- [ ] GET works.
- [ ] HEAD works.
- [ ] POST works with warning/idempotency header.
- [ ] expected status list works.
- [ ] body contains works.
- [ ] body not contains works.
- [ ] response-time ceiling works.
- [ ] timeout works.
- [ ] intervals 1/2/5/10 minutes work.

## Reliability

- [ ] default 3 failures before DOWN.
- [ ] default 2 successes before RECOVERED.
- [ ] one open incident maximum per monitor.
- [ ] duplicate Queue job cannot duplicate incident.
- [ ] duplicate Queue job cannot duplicate email.
- [ ] out-of-order check cannot roll state backwards.
- [ ] manual checks do not affect state/uptime.
- [ ] maintenance checks do not affect state/uptime.

## Email

- [ ] Cloudflare Email Service only.
- [ ] test email action works.
- [ ] DOWN sent once per target.
- [ ] RECOVERED sent once per target.
- [ ] send failures visible/retryable.

## Data/UI

- [ ] clients group monitors.
- [ ] overview operational at a glance.
- [ ] monitor detail history/chart works.
- [ ] 24h/7d/30d/90d uptime works.
- [ ] incidents work.
- [ ] maintenance works.
- [ ] import/export works.
- [ ] rollups and retention work.
- [ ] system health page works.

## External safety net

- [ ] separate Upptime watchdog repo exists after V1 stability.
- [ ] it monitors `/healthz` from outside Cloudflare.

---

# 42. Coding-agent rules

1. Read this document before implementation.
2. Keep implementation clean-room.
3. Do not fork/copy Nanasi source.
4. Prefer the simplest Cloudflare-native implementation that satisfies this spec.
5. Do not introduce a new service when a listed Cloudflare primitive already solves the need.
6. Do not create staging Cloudflare resources.
7. Do not create production resources until the code is locally testable and the owner action gate is reached.
8. Do not hide retries or mutate uptime semantics without tests.
9. Every side effect must be idempotent.
10. Every D1 schema change requires a committed migration.
11. Every important state-machine branch requires tests.
12. Keep secrets out of D1 and Git.
13. Do not create a parallel authentication system; use Access.
14. Do not directly send transition email from request handlers.
15. Do not let Cron perform monitor HTTP checks.
16. Do not rely on in-memory state across Worker invocations.
17. Do not hard-delete operational history in normal product flows.
18. Do not expand scope to V1.1 features without approval.
19. Keep the production deployment human-approved.
20. When Cloudflare APIs/config schemas differ from examples in this document, follow current Cloudflare documentation while preserving the architecture and behavior described here.

---

# 43. Primary platform references

Cloudflare Workers:

- https://developers.cloudflare.com/workers/

Hono on Workers:

- https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/

Cloudflare Vite plugin:

- https://developers.cloudflare.com/workers/vite-plugin/

Workers Static Assets:

- https://developers.cloudflare.com/workers/static-assets/

Cron Triggers:

- https://developers.cloudflare.com/workers/configuration/cron-triggers/

Cloudflare Queues:

- https://developers.cloudflare.com/queues/
- https://developers.cloudflare.com/queues/configuration/javascript-apis/
- https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/

Cloudflare D1:

- https://developers.cloudflare.com/d1/
- https://developers.cloudflare.com/d1/configuration/data-location/

Cloudflare Access:

- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/
- https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/

Cloudflare Email Service:

- https://developers.cloudflare.com/email-service/
- https://developers.cloudflare.com/email-service/get-started/send-emails/
- https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
- https://developers.cloudflare.com/email-service/configuration/send-bindings/

Workers Observability:

- https://developers.cloudflare.com/workers/observability/
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- https://developers.cloudflare.com/workers/observability/traces/

Behavioral/UX reference only — do not copy implementation:

- https://github.com/nanasi-apps/cf-uptime-monitor

External watchdog concept:

- https://github.com/upptime/upptime

---

# 44. Final implementation mental model

```text
                        Cloudflare Access
                               |
                    uptime.morabeza.digital
                               |
                     Worker + React UI
                      /       |       \
                    API      D1     /healthz (public only)
                     |
              scheduled() once/min
                     |
                due monitors
                     |
                 CF Queue
             /       |        \
       monitor     notify    housekeeping
        checks      email       jobs
           \          |          /
                    D1
                     |
          incidents + history + rollups
                     |
          Cloudflare Email Service

Outside Cloudflare, after V1 is stable:

GitHub Upptime ---> https://uptime.morabeza.digital/healthz
```

**Primary principle:** Cron schedules. Queue executes. D1 remembers. Access protects. Email Service alerts. The Worker/UI operates the system. Upptime independently watches the watcher.
