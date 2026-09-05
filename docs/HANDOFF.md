# Handoff — Morabeza CF Uptime

**Date:** 2026-09-05 · **State:** main green, 180/180 tests, CI passing · **Author:** agent session (state chain #12→#10→#14→#15)

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
  4. Run a read-only review pass (morabeza-reviewer agent or equivalent) over the diff; fix CRITICAL/IMPORTANT; note or cheaply fix MINORs.
  5. PR with body starting `Closes #N`, a **What** section (with PRD § refs) and a **Verification** checklist mirroring the issue's acceptance criteria (checked boxes = actually verified).
  6. `gh pr merge <n> --squash --delete-branch`; `git checkout main && git pull`.
  7. Confirm the issue closed and CI succeeded on main.

## 2. Current state

**Closed (merged):** #1 #2 #3 #4 #5 #6 #8 #9 **#12 #10 #14 #15** #16 — i.e. scaffold, ADRs, D1 schema, API shell + clients, monitors CRUD, HTTP checker, queue infra, monitor.check pipeline, **state machine, cron scheduler, manual checks, maintenance windows**, notification targets.

**Open, in dependency order:** #13 (incidents) → #17 (email) → #11 (healthz) → #18/#19 (rollups/retention) → #20 (uptime API) → #21–#27 (UI + bulk) → #28–#31 (deploy/HITL). #7 (deterministic local test targets) is open but mostly superseded — every pipeline test mocks `fetch` against real miniflare D1; close it with a note or fold its remainder into #18's tests.

### Architecture as-built (map)

```
worker/
  index.ts            fetch + queue (main/DLQ router) + scheduled (cron) exports
  app.ts              Hono shell: /healthz (stub — #11), /api/* behind Access+origin
  env.ts              DB, CHECK_QUEUE, APP_ORIGIN, APP_ACCESS_MODE (EMAIL binding: #17)
  lib/                db(drizzle), errors(ApiError), ids(newId), time(nowIso),
                      logging(logEvent), validation(zod body/query), url-safety,
                      monitor-schema, maintenance-schema
  repositories/       clients, monitors, notifications(targets+resolveTargets),
                      system(heartbeats), audit(recordAudit), monitor-state(CAS),
                      maintenance(windows + findActiveMaintenanceWindow)
  services/           checker(#6), state-machine(pure core), state-evaluation(gates+
                      ordering+CAS loop+transition seam), manual-check
  scheduler/          scheduler.ts — runSchedulerTick, housekeepingJobsForSlot
  queue/              producer(QueueProducer, queueBindingToQueueLike), schemas(envelopes),
                      consumer(router+registry), idempotency(claimUniqueRow),
                      dlq-consumer, handlers/monitor-check
  routes/             clients, monitors(+POST /:id/check), notifications, maintenance
tests/unit/*          real D1 via miniflare (tests/helpers/d1.ts); fetch always mocked
```

**Verification:** `pnpm lint && pnpm typecheck && pnpm test` (typecheck = 3 tsconfigs; CI runs lint+typecheck+test+build).

## 3. Hard-won contracts & gotchas (read before coding)

1. **Idempotency pattern:** every queue side effect is claimed by `claimUniqueRow` (insert `.onConflictDoNothing().returning()` → boolean). First delivery owns ALL side effects; duplicates ack and do nothing (PRD §16.3/16.4). Deterministic ids make this work: `checkId = ${monitorId}:${slot}`.
2. **`scheduledFor` format contract:** ms-precision UTC ISO-8601 everywhere (`nowIso()`/`minuteSlot`). The #12 ordering guard compares slots **lexicographically** — a producer using another format silently breaks out-of-order protection. The zod `utcIso` helper in `lib/maintenance-schema.ts` enforces the same shape at the API boundary.
3. **Transition seam (#12):** `MonitorCheckDeps.onTransition` fires **exactly once per check result**, after the state CAS commits. A redelivery duplicate-skips (#9) and can never re-emit. **Listeners must be idempotent keyed by `checkId` and must never throw past the seam** — throws are isolated and logged (`state.transition_listener_failed`) because a propagated throw retries the message into the duplicate-skip and loses the event forever. #13/#17 subscribe here.
4. **Evaluator gates** (`services/state-evaluation.ts`): evaluation runs only for results with `affects_state=1 && maintenance_excluded=0 && status != paused`. Manual and maintenance results bypass state/counters/incidents/notifications by construction — don't add special cases downstream.
5. **Transition types:** `down` | `recovered` | `up`. `up` = unknown→up (§12.5) and must NOT trigger RECOVERED notifications. `down` events carry `failureSequenceStartedAt` = first failure of the qualifying sequence → incident `first_failure_at`.
6. **CAS on D1:** `casUpdateMonitorState(db, monitorId, expectedVersion, patch)` — drizzle skips `undefined` values in `.set()` (used for last_success_at/last_failure_at). `db.batch()` requires a **non-empty tuple**: destructure `const [first, ...rest]` and spread.
7. **Test harness:** each test file gets its own miniflare D1 with committed migrations (`createTestDb()`); **within a file the D1 is shared**, and because check ids are deterministic per slot, colliding slots across tests trip #9's duplicate-skip instead of what you meant to test — use unique slots/ids per test. For time-based fixtures (maintenance windows) insert offsets from `Date.now()`, not raw epoch ms. Clean up leftover live fixtures (`clearWindows` pattern) when asserting non-exclusion.
8. **Queue stubs:** `rollup.hourly`, `rollup.daily`, `retention.cleanup` handlers intentionally throw → retry ×3 → DLQ (fail-loud, #8's design) until #18/#19 land. Expect ~a few DLQ rows/day; don't "fix" this. Known race recorded for #18: the daily rollup (00:06) may be consumed before the 23:xx hourly rollup (00:05) and deterministic ids prevent re-runs — rollup handlers must compute from `check_results` or verify hourly completeness.
9. **State machine CAS conservatism:** after 3 lost CAS attempts a state-affecting result is dropped as history (`state.evaluation_dropped`); conservative, self-corrects next slot. Monitor via logs if ever needed.
10. **API conventions:** Hono routes in `routes/*`, `parseJsonBody(c, zodSchema)`, `ApiError` categories (validation 400 / not_found 404 / conflict 409 / rate_limited 429 — no static helper for the last one, use `new ApiError("rate_limited", ...)`), response envelope `{ data }` or `{ error }`, `recordAudit` on every mutation, Access actor via `c.get("actorEmail")`.
11. **Env/queue adapter:** production `Queue` binding ↔ `QueueLike` via `queueBindingToQueueLike` in `queue/producer.ts`. Tests inject recording fakes `{ send, sendBatch }`.
12. **Lint:** `@typescript-eslint/no-unused-vars` is an error (watch arrow-function listener bodies — `(e) => arr.push(e)` returns a number and fails the `void` listener type; use a block body). LF/CRLF warnings on Windows are noise.

---

## 4. Next chain — 3 issues for the agent, in order

Do them **sequentially** (#17 needs #13). Full specs live in `gh issue view NNN` — the instructions below add the implementation map that only the current code knows. Do **not** create new GitHub issues; these exist.

---

### 4.1 Issue #13 — Incidents: open/resolve wired into the check pipeline

**Why now:** unblocked by #12; the transition seam is sitting idle; #17 is blocked on it.

**Implementation map:**
- New `worker/services/incidents.ts` exporting a `TransitionListener`-compatible handler, e.g. `handleIncidentLifecycle(event: StateTransitionEvent): Promise<void>`.
- Compose it into the default registry: in `queue/consumer.ts` `defaultRegistry`, wrap `createMonitorCheckHandler` deps so `onTransition` = log + incidents (+ #17 later). Keep `MonitorCheckDeps.onTransition` injectable so tests can spy.
- **DOWN:** claim the incident by inserting with `onConflictDoNothing` — migration `0001_seed_and_guards.sql` already has the partial unique index `incidents_one_open_per_monitor_idx (monitor_id) WHERE status='open'`, so a lost insert = an incident is already open = idempotent no-op (satisfies §37.2). Fields: `id = newId("inc")`, `status: "open"`, `opened_at = event.at`, `first_failure_at = event.transition.failureSequenceStartedAt` (already carried!), `trigger_check_id = event.checkId`, `open_reason_code` — needs the check's `reasonCode`, so **add `reasonCode: string` to `StateTransitionEvent`** (additive; set it in `state-evaluation.ts` where the event is built; thread from `CheckResultForEvaluation`).
- Then link it: `UPDATE monitor_state SET open_incident_id = ? WHERE monitor_id = ? AND open_incident_id IS NULL` (conditional update — do NOT bump state_version; the machine owns version, and open_incident_id has no ordering semantics).
- **RECOVERED:** find the open incident for the monitor, set `status: "resolved"`, `resolved_at = event.at`, `recovery_check_id = event.checkId`, `outage_duration_ms = Date.parse(at) - Date.parse(opened_at)`, `resolution_reason: "recovered"`; then `UPDATE monitor_state SET open_incident_id = NULL WHERE monitor_id = ? AND open_incident_id = ?`. Idempotent: resolution only applies while the incident row is still `open` (`WHERE status='open'` in the update).
- **`up` (unknown→up):** do nothing. No incident, no recovery (§12.5). The listener should switch on `event.transition.type` and ignore `up`.
- Existing code already closes incidents on monitor disable/archive (`repositories/monitors.ts` updateMonitor disable path — `closed_admin` + `monitor_disabled`) — do not touch it; your scope is the check pipeline only.

**Tests (add to a new `tests/unit/incidents.test.ts`):**
- failing sequence → DOWN → exactly one open incident with correct `first_failure_at` (state machine already guarantees one `down` transition per outage — assert the row, not just the count);
- duplicate listener invocation / redelivered message → still exactly one incident (hit the listener twice directly with the same event);
- recovery → incident resolved with `outage_duration_ms > 0`, `recovery_check_id` set, `monitor_state.open_incident_id` null;
- unknown→up emits no incident rows;
- disable monitor while incident open (reuse the #5 API test fixture) still closes it `closed_admin` (regression);
- §37.2 explicitly: duplicate state-transition execution → no duplicate incidents.

**Definition of done:** issue ACs checked, gates green, PR merged. No notifications yet (#17) — DOWN/RECOVERED still send nothing.

---

### 4.2 Issue #17 — Email pipeline: dedupe keys, DOWN/RECOVERED jobs, retries, test email

**Why now:** #13 (this chain) + #16 (done) unblock it; this completes the alerting backbone.

**Implementation map:**
- Subscribe another listener in the same composition point as #13 (see 4.1): on `down` → resolve recipients via `resolveTargets(env, monitorId)` in `repositories/notifications.ts` (explicit mappings first, then `is_default` fallback — already implemented); for each target insert `notification_events` row `status: "pending"`, `type: "down"`, `incident_id` (read it from `monitor_state.open_incident_id` or the incident you just claimed), **`dedupe_key = ${incidentId}:down:${targetId}`** — the unique index `notification_events_dedupe_key_idx` makes inserts idempotent (§37.3). Same for `recovered`. Then enqueue `notification.send` jobs — **after** persistence commits (§37.5), `jobId = notificationEventId` (deterministic per event row), payload `{ notificationEventId }` (schema already exists in `queue/schemas.ts`).
- Implement the real `notification.send` handler (replace the `notImplemented` stub in `consumer.ts` registry): load the event; if `status !== "pending"` → ack no-op (already handled); set `sending` → render subject/body per PRD §9.4/§9.5 → send → `sent` + `provider_message_id` + `sent_at`; on failure `attempts += 1`, `last_error`, back to `pending` and `message.retry({ delaySeconds })` so queue retries drive §9.6; after max attempts let it throw → DLQ (existing plumbing).
- **EMAIL binding does not exist yet:** add `EMAIL: SendEmail` to `worker/env.ts` and the `send_email` binding to `wrangler.jsonc` (production values still finalized in #28/#29 — a placeholder binding name is fine), and make the handler take an injectable `sendEmail` dep (like `fetchImpl`) so tests fake it. If local testing of the real binding proves impossible, that's a decision gate → `DECISION_NEEDED.md`.
- Test-email endpoint per the issue body (PRD §24): `POST /api/notification-targets/:id/test` in `routes/notifications.ts` — inserts a `type: "test"` event (dedupe key `${targetId}:test:${uuid}` — unique per invocation) + enqueues; audit event.

**Tests (extend the #13 file or new `tests/unit/notification-pipeline.test.ts` — the PRD §32.1 Notifications matrix is the checklist):**
- DOWN → one pending event per resolved target, none for non-mapped non-default targets; dedupe key collision (duplicate delivery) → still one row;
- RECOVERED → `recovered` events referencing the incident;
- duplicate `notification.send` message → no double email (second delivery sees non-pending → ack);
- send failure → attempts/error recorded, retry scheduled; eventual success → sent + provider id;
- unknown→up → zero `recovered` events (§12.5 — assert explicitly);
- manual/maintenance checks never produce events (feed a manual result through the pipeline);
- test email works with zero incidents.

**Definition of done:** issue ACs checked, gates green, merged. **Decision gate note:** if you change the envelope schema or add vars beyond EMAIL, stop and write `DECISION_NEEDED.md`.

---

### 4.3 Issue #11 — Public /healthz with real degradation checks

**Why now:** unblocked since #10; small, self-contained; production gating for #28.

**Implementation map:**
- Replace the stub in `worker/app.ts` (`app.get("/healthz", ...)`). Spec is PRD §19 — it is deliberately minimal: `{"status":"ok"}` 200 or `{"status":"degraded"}` 503, `Cache-Control: no-store`, **no version hashes, ids, or timestamps**.
- Checks, in order: (1) D1 executes a lightweight query (`SELECT id FROM system_state WHERE id='system'` — doubles as the heartbeat read); (2) `last_scheduler_at` ≤ **3 min** old; (3) `last_queue_consumer_at` ≤ **10 min** old (kept fresh by real jobs + the every-5-min `system.heartbeat` from #10).
- "after bootstrapping" nuance: if `system_state` row doesn't exist yet (fresh deploy), treat heartbeats as fresh-unknown → `ok`, not permanently degraded (log a bootstrap marker); PRD says the staleness applies *after bootstrapping* — implement a grace: missing row = ok, present-but-stale = degraded.
- Unauthenticated by design (it sits outside the `/api` middleware already) and must NOT call Email Service or any queue send (§19). Put the logic in a small testable module (`worker/services/healthz.ts` returning `{ status, checks }` internally; the route renders only the two-field JSON).

**Tests (`tests/unit/healthz.test.ts`):** fresh heartbeats → 200 ok; scheduler heartbeat 4 min old → 503 degraded; consumer heartbeat 11 min old → 503; missing system_state row → 200 (bootstrap grace); D1 failure (dispose miniflare or break binding) → 503; response has `no-store` and contains only `status`; route needs no auth headers.

**Definition of done:** issue ACs checked, gates green, merged.

---

## 5. After this chain

Next in line, in order: **#18** (rollups — remember gotcha 8's ordering race; compute from `check_results`) → **#19** (retention) → **#20** (uptime API; eligibility filter = `source='scheduled' AND maintenance_excluded=0`) → **#21–#27** (UI) → **#28** (deploy). Decide #7's fate (close-with-note is fine) when you touch #18.
