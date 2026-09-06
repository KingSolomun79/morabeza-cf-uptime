# Handoff — Morabeza CF Uptime

**Date:** 2026-09-06 · **State:** main green, 219/219 tests, CI passing · **Author:** agent session (state chain #12→#10→#14→#15→#13→#17→#11)

---

## 1. Mission & ground rules

Build a Cloudflare-uptime monitor (single Worker + D1 + Queues + Email) from `docs/PRD-SPEC.md` — the **authoritative spec**. This is a **clean-room** implementation (PRD §3): never copy from the reference project (`upptime`), never reuse its code or assets.

- Every unit of work is a **GitHub issue** (mirrored 1:1 in `issues/NNN-*.md`). The issue body + its PRD § references are the contract. Do not invent scope.
- Issues marked `afk` are for autonomous agents; `hitl` (#29–#31) need the human owner.
- If an implementation choice would change a schema/contract beyond what the issue allows, stop and write `DECISION_NEEDED.md` (per-issue "Decision gates" name these).
- **Per-issue workflow (proven, follow it exactly):**
  1. `git checkout main && git pull && git checkout -b feat/NNN-slug`
  2. Implement with tests first/alongside. Reuse existing patterns (see §3).
  3. Gates: `pnpm lint && pnpm typecheck && pnpm test` — all green, always.
  4. Run a read-only review pass (morabeza-reviewer agent or equivalent) over the diff; fix CRITICAL/IMPORTANT; cheaply fix or note MINORs.
  5. PR with body starting `Closes #N`, a **What** section (with PRD § refs) and a **Verification** checklist mirroring the issue's acceptance criteria (checked boxes = actually verified).
  6. `gh pr merge <n> --squash --delete-branch`; `git checkout main && git pull`.
  7. Confirm the issue closed and CI succeeded on main.

## 2. Current state

**Closed (merged):** #1–#6 #8 #9 #12 #10 #14 #15 #16 **#13 #17 #11** — scaffold, ADRs, D1 schema, API shell + clients, monitors CRUD, HTTP checker, queue infra, monitor.check pipeline, state machine, cron scheduler, manual checks, maintenance windows, notification targets, **incidents, the full email pipeline, and real /healthz**. The alerting backbone is end-to-end: failure streak → incident → deduped notification_events → queued sends with retries → `[DOWN]`/`[RECOVERED]` emails (testable with a fake sender).

**Open, in dependency order:** **#18 (rollups) → #19 (retention) → #20 (uptime API)** → #21–#27 (UI + bulk) → #28–#31 (deploy/HITL/watchdog). #7 (deterministic local test targets) is still open but superseded — every pipeline test mocks `fetch` against real miniflare D1; close it with a note when you touch #18.

### Architecture as-built (map)

```
worker/
  index.ts            fetch + queue (main/DLQ router) + scheduled (cron) exports
  app.ts              Hono shell: /healthz (#11, real degradation checks, outside auth group),
                      /api/* behind Access+origin
  env.ts              DB, CHECK_QUEUE, EMAIL?: SendEmail, DEFAULT_FROM_EMAIL?, APP_ORIGIN,
                      APP_ACCESS_MODE (+#17)
  lib/                db(drizzle), errors(ApiError), ids(newId), time(nowIso),
                      logging(logEvent), validation(zod body+query), url-safety,
                      monitor-schema, maintenance-schema
  repositories/       clients, monitors(disable closes incidents closed_admin), notifications
                      (targets+resolveTargets), system(heartbeats), audit(recordAudit),
                      monitor-state(CAS), maintenance(windows+findActiveMaintenanceWindow)
  services/           checker(#6), state-machine(pure core), state-evaluation(gates+ordering+
                      CAS+transition seam), incidents(#13: claim via partial unique index),
                      notifications(#17: intents+templates+queueTestEmail), healthz(#11),
                      manual-check
  scheduler/          scheduler.ts — runSchedulerTick; housekeepingJobsForSlot already emits
                      deterministic envelopes: rollup.hourly @ :05, rollup.daily @ 00:06,
                      retention.cleanup @ 00:07, system.heartbeat every 5th minute
  queue/              producer(QueueProducer, queueBindingToQueueLike), schemas(envelopes),
                      consumer(router+registry: monitor.check+notification.send LIVE,
                      rollup.hourly/rollup.daily/retention.cleanup fail-loud stubs),
                      idempotency(claimUniqueRow), dlq-consumer,
                      handlers/monitor-check(defaultTransitionPipeline: log→incidents→intents),
                      handlers/notification-send
  routes/             clients, monitors(+POST /:id/check), notifications(+POST /:id/test),
                      maintenance, incidents(GET list open-first paginated + detail)
db/migrations/        0000 schema, 0001 one-open-incident partial index + seed, 0002
                      notification_events.monitor_id nullable (test events)
tests/unit/*          real D1 via miniflare (tests/helpers/d1.ts — includes a default no-op
                      CHECK_QUEUE fake); fetch always mocked; email sender faked
```

**Verification:** `pnpm lint && pnpm typecheck && pnpm test` (typecheck = 3 tsconfigs; CI runs lint+typecheck+test+build).

## 3. Hard-won contracts & gotchas (read before coding)

1. **Idempotency pattern:** every queue side effect is claimed by `claimUniqueRow` (insert `.onConflictDoNothing().returning()` → boolean). First delivery owns ALL side effects; duplicates ack and do nothing (PRD §16.3/16.4). Deterministic ids make this work: `checkId = ${monitorId}:${slot}`. NOTE: rollups (#18) are different — they must RECOMPUTE and overwrite on re-delivery (upsert, `.onConflictDoUpdate()`), not insert-once.
2. **`scheduledFor` format contract:** ms-precision UTC ISO-8601 everywhere (`nowIso()`/`minuteSlot`). The #12 ordering guard compares slots **lexicographically** — a producer using another format silently breaks out-of-order protection.
3. **Transition seam (#12) + default pipeline:** `MonitorCheckDeps.onTransition` fires **exactly once per check result**, after the state CAS commits. The DEFAULT pipeline (when `onTransition` is not injected) is `logTransitionEvent → handleIncidentLifecycle → handleNotificationIntents` — **order matters**: intents anchor on the incident the previous listener just persisted. An injected `onTransition` (tests) REPLACES the whole pipeline. Listeners must be idempotent keyed by `checkId` and never throw past the seam — throws are isolated and logged (`state.transition_listener_failed`) because a propagated throw retries the message into the duplicate-skip and loses the event forever.
4. **Evaluator gates** (`services/state-evaluation.ts`): evaluation runs only for results with `affects_state=1 && maintenance_excluded=0 && status != paused`. Manual and maintenance results bypass state/counters/incidents/notifications by construction — don't add special cases downstream.
5. **Transition types:** `down` | `recovered` | `up`. `up` = unknown→up (§12.5) and must NOT trigger RECOVERED notifications. `down` events carry `failureSequenceStartedAt` + `reasonCode` → incident `first_failure_at`/`open_reason_code`.
6. **CAS on D1:** `casUpdateMonitorState(db, monitorId, expectedVersion, patch)` — drizzle skips `undefined` values in `.set()` (used for last_success_at/last_failure_at). `db.batch()` requires a **non-empty tuple**: destructure `const [first, ...rest]` and spread.
7. **Test harness:** each test file gets its own miniflare D1 with committed migrations (`createTestDb()`); **within a file the D1 is shared**, and because check ids are deterministic per slot, colliding slots across tests trip #9's duplicate-skip instead of what you meant to test — use unique slots/ids per test. For time-based fixtures (maintenance windows, heartbeats) insert offsets from `Date.now()`, not raw epoch ms. When you ADD a migration, bump the `expect(paths.length).toBe(N)` guard in api-clients/api-notifications/db-schema tests. **D1 enforces FKs in both directions** — you cannot seed an orphaned row (e.g. a notification event with a missing target) to test defensive branches.
8. **Queue stubs:** after #17, only `rollup.hourly`, `rollup.daily`, `retention.cleanup` intentionally throw → retry ×3 → DLQ until #18/#19 land (~a few DLQ rows/day; don't "fix" this). Known race for #18: the daily rollup (00:06) may be consumed before the 23:xx hourly rollup (00:05) and deterministic ids prevent re-runs — **rollup handlers must compute from `check_results`, never sum hourly rows.**
9. **Email durability model (#17):** intent rows are created BEFORE jobs are enqueued (§9.6); the send handler's retryable catch spans lookup + render + send (any throw after the `sending` claim returns the row to `pending` — never strands a row); enqueue failure after insert marks the claimed rows `failed` (visible) since the seam never re-fires. **Known residual:** isolate eviction mid-send leaves `sending` stuck and redeliveries ack (choosing §37.3 no-double-send over at-least-once) — a stale-`sending`/stale-`pending` reconciler is a natural #18/#19 housekeeping addition.
10. **Incident semantics:** `outage_duration_ms` is anchored on `opened_at` (threshold crossing), NOT `first_failure_at` (sequence start) — consistent with the #5 disable path. If #18's `downtime_ms` needs sequence-anchored downtime, that's a decision to surface. `monitor_state.open_incident_id` is maintained WITHOUT bumping `state_version` (the machine owns versions).
11. **API conventions:** Hono routes in `routes/*`, `parseJsonBody(c, zodSchema)`, `parseQuery(c, zodSchema)`, `ApiError` categories (validation 400 / not_found 404 / conflict 409 / rate_limited 429 — `new ApiError("rate_limited", ...)`), envelope `{ data }` or `{ error }`; paginated lists use `{ data, pagination: { total, limit, offset } }` (introduced by `/api/incidents` — reuse for checks/uptime/dead-letters). `recordAudit` on every mutation; Access actor via `c.get("actorEmail")`.
12. **Env/queue adapter:** production `Queue` binding ↔ `QueueLike` via `queueBindingToQueueLike`. `defaultRegistry(checkerDeps, notificationDeps)`; tests inject recording fakes `{ send, sendBatch }` (the helper's default is a silent no-op). `EMAIL?: SendEmail` is optional in `Env` — the send handler fails loudly (row → `pending` + `last_error` → retry → DLQ) when the binding is absent at runtime; tests inject `notificationDeps.sendEmail`.
13. **Healthz semantics (#11):** a never-written heartbeat (missing row or NULL field) is fresh-unknown → `ok` (bootstrap grace, non-flapping by construction); an existing-but-stale timestamp → `degraded`; unparseable → degraded (fail-closed). Response is EXACTLY `{"status":"ok"|"degraded"}` — single field (HANDOFF v1 said "two-field"; PRD §19 is the law and ships).
14. **Lint:** `@typescript-eslint/no-unused-vars` is an error (watch arrow-function listener bodies — `(e) => arr.push(e)` returns a number and fails the `void` listener type; use a block body). LF/CRLF warnings on Windows are noise.

---

## 4. Next chain — 3 issues for the agent, in order

Do them **sequentially** (#20 needs #18's rollups; #19 is independent of #18 but slots between them cleanly). Full specs live in `gh issue view NNN` — the instructions below add the implementation map that only the current code knows. Do **not** create new GitHub issues; these exist.

---

### 4.1 Issue #18 — Hourly/daily rollups + deterministic housekeeping

**Why now:** unblocks #20 (uptime API); retires the last intentional DLQ noise alongside #19.

**Implementation map:**
- The dispatch ALREADY exists: `housekeepingJobsForSlot` emits `rollup.hourly:{hourStart}` at :05, `rollup.daily:{dayStart}` at 00:06 UTC, `retention.cleanup:{today}` at 00:07 (scheduler/scheduler.ts). Your job is the handlers in the `defaultRegistry` (consumer.ts), replacing the two `notImplemented` stubs.
- Eligibility filter (§26, used everywhere downstream — get it exactly right): `source='scheduled' AND maintenance_excluded=0 AND affects_state=1`.
- **Upsert, not claim:** re-delivered rollup jobs must recompute and overwrite (`insert(...).onConflictDoUpdate({ target: [hourlyRollups.monitorId, hourlyRollups.hourStart], set: {...} })`) — `claimUniqueRow`'s insert-once semantics would make a re-run a no-op and the race in gotcha 8 permanent. Deterministic jobIds already guarantee no double-count from concurrent duplicates IF the recompute is deterministic (aggregate from `check_results` by completed_at window).
- **Compute from `check_results` directly** (gotcha 8's ordering race) — never sum hourly rows. Hour window: `completed_at >= hourStart AND < hourStart + 1h` (UTC, lexicographic comparisons work with the ISO format).
- Response-time aggregates (min/avg/max) over `response_time_ms`; avg is REAL — decide and document rounding (store the raw real; PRD doesn't pin it).
- Daily adds `incident_count` + `downtime_ms`: incidents table only has `opened_at`/`resolved_at` (+ status). Simplest defensible V1: count incidents OPENED in the window; downtime = `outage_duration_ms` summed for those (still-open incidents at window end have no duration yet — clip elapsed time to the window end or skip with a note; document the choice in the PR).
- Heartbeats: set `last_hourly_rollup_at` / `last_daily_rollup_at` (columns exist in `system_state`) on success — extend `repositories/system.ts` with touch helpers mirroring the existing two.
- While you're in housekeeping: consider adding a `notification.reconcile` sweep for stale `sending`/`pending` notification_events (gotcha 9's residual). It's NOT in the issue scope — if you add it, it's additive housekeeping (document in the PR), otherwise leave for a follow-up.
- Close #7 with a note in this PR (superseded: pipeline tests mock fetch against real miniflare D1).

**Tests (`tests/unit/rollups.test.ts`):**
- deterministic fixture (known checks across hours/days) → exact hourly/daily rows; §32.1: rollup and raw agree;
- manual (`affects_state=0`) and maintenance-excluded rows never appear;
- run the same job twice → identical rows (no double counting);
- the gotcha-8 race: run `rollup.daily` BEFORE the last hourly of the previous day → daily row still correct (proves computation from raw);
- outage fixture → `incident_count`/`downtime_ms` correct;
- heartbeats updated; a rollup failure never blocks monitor scheduling (already structurally true — assert it).

**Definition of done:** issue ACs checked, gates green, PR merged. DLQ noise halves (only retention.cleanup remains until #19).

---

### 4.2 Issue #19 — Retention cleanup with configurable vars

**Why now:** pairs with #18 (same housekeeping dispatch); keeps D1 small before UI ships.

**Implementation map:**
- Replace the `retention.cleanup` stub. Job arrives with empty payload `{}`; the UTC date is already in the jobId — derive the run boundary from `nowIso()` inside the handler.
- Vars (non-secret): `RAW_CHECK_RETENTION_DAYS` / `HOURLY_RETENTION_DAYS` / `DAILY_RETENTION_DAYS` — §18 defaults are raw **7d**, hourly **90d**, daily **730d**; `scheduler_runs` fixed 7d. Add optional `Env` fields + a `wrangler.jsonc` `vars` block (PRD's deploy example already shows all three). Never touch: monitors, incidents, maintenance_windows; `notification_events` + `audit_events` retain **≥365 days**; `dead_letter_events`: "retain until resolved + operational retention policy" — pick and document what resolved rows do (either reading is allowed).
- **Batched deletes only** (D1-friendly): `DELETE FROM check_results WHERE id IN (SELECT id FROM check_results WHERE completed_at < ? LIMIT 500)` in a loop until 0 rows — never one unbounded statement. Same pattern for the other tables.
- `last_cleanup_at` heartbeat + one structured summary log with deletion counts (PRD §28).
- Idempotent: re-delivery for the same day finds nothing past the boundary → deletes nothing twice.

**Tests (`tests/unit/retention.test.ts`):** fixtures just-inside/just-outside each boundary; newer data untouched; incidents/maintenance/notification/audit survive; re-delivery harmless; batch loop honors the limit (seed >limit rows); vars override the defaults; heartbeat + summary logged.

**Definition of done:** ACs checked, gates green, merged. After this, the DLQ is silent in steady state.

---

### 4.3 Issue #20 — Uptime calculations + `GET /api/monitors/:id/uptime`

**Why now:** #18's rollups exist; this is the number the UI (#22/#24) renders.

**Implementation map:**
- `worker/services/uptime.ts` (pure + queryable): `window=24h|7d|30d|90d` → `{ percentage, eligible, healthy, source: "raw"|"rollup"|"blended" }` or explicit `no_data`.
- Eligibility filter is gotcha-8-grade law: `source='scheduled' AND maintenance_excluded=0 AND affects_state=1`; healthy = `is_healthy=1`. Paused intervals simply contribute no eligible checks → if ZERO eligible in the window, return `no_data` (NOT 100%).
- Strategy: raw `check_results` within retention; `hourly_rollups`/`daily_rollups` for older spans; blend when a window straddles the boundary. **Derive the switchover from #19's `RAW_CHECK_RETENTION_DAYS`** so retention and uptime never disagree (the issue's implementation note).
- Percentage: `healthy / eligible * 100`, exact math (98/100 → 98.00); watch float formatting — round to 2 decimals at the edge, keep full precision in queries (SQL avg of rollup up_checks/eligible_checks weighted by eligible_checks, not plain avg).
- Route: `GET /api/monitors/:id/uptime?window=…` in `routes/monitors.ts`; zod-validated window (invalid → 400 validation envelope); unknown monitor → 404 envelope (`ApiError.notFound`).
- Queries must be aggregate/indexed: `(monitor_id, completed_at DESC)` index exists for raw; rollups are keyed `(monitor_id, hour_start/day_start)`. No full scans (PRD §36).

**Tests (`tests/unit/uptime.test.ts`):** §32.1 matrix — manual excluded; maintenance excluded; paused/no-data → `no_data`; rollup vs raw agreement on a deterministic fixture; 24h/7d from raw; 30d/90d from rollups; a straddling window blends; 98-of-100 → 98.00; unknown monitor 404; invalid window 400.

**Definition of done:** ACs checked, gates green, merged.

---

## 5. After this chain

**UI era:** #21 (foundation) → #22 (overview + dashboard API) → #23 (monitors) → #24 (monitor detail) → #25 (clients/incidents/maintenance) → #26 (notifications/system) → #27 (bulk import/export). Then #28 (deploy workflow, afk) → #29–#31 (HITL: provisioning, rollout, Upptime watchdog watching /healthz).

Deep-link paths already emitted in emails (`${APP_ORIGIN}/monitors/:id`, `${APP_ORIGIN}/incidents/:id`) — UI (#21/#24/#25) should honor them or the emails need a follow-up path fix.
