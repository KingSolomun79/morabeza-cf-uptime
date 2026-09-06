# Handoff — Morabeza CF Uptime

**Date:** 2026-09-06 · **State:** main green, 436/436 tests, CI passing · **Author:** agent session (UI era **#21→#27 COMPLETE**; next #28, then HITL #29–#31)

---

## 1. Mission & ground rules

Build a Cloudflare-uptime monitor (single Worker + D1 + Queues + Email) from `docs/PRD-SPEC.md` — the **authoritative spec**. This is a **clean-room** implementation (PRD §3): never copy from the reference project (`upptime`), never reuse its code or assets.

- Every unit of work is a **GitHub issue** (mirrored 1:1 in `issues/NNN-*.md`). The issue body + its PRD § references are the contract. Do not invent scope.
- Issues marked `afk` are for autonomous agents; `hitl` (#29–#31) need the human owner.
- If an implementation choice would change a schema/contract beyond what the issue allows, stop and write `DECISION_NEEDED.md` (per-issue "Decision gates" name these).
- **Per-issue workflow (proven, follow it exactly):**
  1. `git checkout main && git pull && git checkout -b feat/NNN-slug`
  2. Implement with tests first/alongside. Reuse existing patterns (see §3).
  3. Gates: `pnpm lint && pnpm typecheck && pnpm test` — all green, always (`pnpm build` too; CI runs all four).
  4. Run a read-only review pass (morabeza-reviewer agent or equivalent) over the diff; fix CRITICAL/IMPORTANT; cheaply fix or note MINORs.
  5. PR with body starting `Closes #N`, a **What** section (with PRD § refs) and a **Verification** checklist mirroring the issue's acceptance criteria (checked boxes = actually verified).
  6. `gh pr merge <n> --squash --delete-branch`; `git checkout main && git pull`.
  7. Confirm the issue closed and CI succeeded on main.

## 2. Current state

**Closed (merged):** #1–#6 #8 #9 #12 #10 #14 #15 #16 #13 #17 #11 #18 #19 #20 — scaffold, ADRs, D1 schema, API shell + clients, monitors CRUD, HTTP checker, queue infra, monitor.check pipeline, state machine, cron scheduler, manual checks, maintenance windows, notification targets, incidents, the full email pipeline, real /healthz, hourly/daily rollups, retention cleanup, and the uptime API.

**UI era COMPLETE (#21–#27, every §27.2 nav section is a real page):** **#21** (foundation) → **#22** (Overview + GET /api/dashboard) → **#23** (Monitors CRUD UI; validation REUSES worker zod schemas) → **#24** (monitor detail: uptime windows, Recharts chart + labeled maintenance overlays, checks history via NEW GET /api/monitors/:id/checks + /:id/incidents) → **#25** (clients list/detail, incidents list/detail with check timeline, maintenance CRUD with Cape_Verde wall-time inputs; zero new API surface) → **#26** (notifications page + system page; NEW GET /api/system, dead-letter list + resolve-with-notes, GET /api/notification-events; heartbeat freshness law EXTRACTED to worker/lib/heartbeat.ts, shared with #11's healthz; APP_VERSION wrangler var) → **#27** (bulk import POST /api/monitors/import + export GET /api/monitors/export; Import/Export page; commit policy: validate whole file → create valid, skip duplicates flagged-not-duplicated → idempotent round-trip; MAX_IMPORT_ROWS=100 chosen against the D1 per-request query budget; the placeholder-page component is DELETED).

**Open, in dependency order:** **#28 (production deploy workflow + final wrangler.jsonc + smoke script, afk)** → **#29–#31 (HITL — require the human OWNER; do not start autonomously)**: provisioning + first deploy + smoke gate (#29), initial monitor rollout (#30), external Upptime watchdog (#31).

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
                      manual-check, rollups(#18: recompute+upsert hourly/daily),
                      retention(#19: bounded batched deletes, parseRetentionDays shared),
                      uptime(#20: 24h/7d/30d/90d raw↔rollup blend)
  scheduler/          scheduler.ts — runSchedulerTick; housekeepingJobsForSlot already emits
                      deterministic envelopes: rollup.hourly @ :05, rollup.daily @ 00:06,
                      retention.cleanup @ 00:07, system.heartbeat every 5th minute
  queue/              producer(QueueProducer, queueBindingToQueueLike), schemas(envelopes),
                      consumer(router+registry: ALL SIX types live — monitor.check,
                      notification.send, rollup.hourly/daily, retention.cleanup, heartbeat),
                      idempotency(claimUniqueRow), dlq-consumer,
                      handlers/monitor-check(defaultTransitionPipeline: log→incidents→intents),
                      handlers/notification-send, handlers/rollups, handlers/retention-cleanup
  routes/             clients, monitors(+POST /:id/check, +GET /:id/uptime #20), notifications
                      (+POST /:id/test), maintenance, incidents(GET list open-first paginated +
                      detail)
db/migrations/        0000 schema, 0001 one-open-incident partial index + seed, 0002
                      notification_events.monitor_id nullable (test events)
tests/unit/*          real D1 via miniflare (tests/helpers/d1.ts — includes a default no-op
                      CHECK_QUEUE fake); fetch always mocked; email sender faked
```

**Verification:** `pnpm lint && pnpm typecheck && pnpm test` (typecheck = 3 tsconfigs; CI runs lint+typecheck+test+build).

## 3. Hard-won contracts & gotchas (read before coding)

1. **Idempotency patterns — two flavors:** (a) monitor.check side effects are claimed by `claimUniqueRow` (insert `.onConflictDoNothing().returning()` → boolean); first delivery owns ALL side effects, duplicates ack and do nothing (PRD §16.3/16.4; `checkId = ${monitorId}:${slot}`). (b) Rollups/retention (#18/#19) are the OPPOSITE: rollup jobs RECOMPUTE + upsert (`.onConflictDoUpdate()`) so re-deliveries fold in late raw rows; retention deletes by time-derived boundary so re-delivery deletes 0. Never apply claim-once to housekeeping (the gotcha-8 ordering race would become permanent).
2. **`scheduledFor` format contract:** ms-precision UTC ISO-8601 everywhere (`nowIso()`/`minuteSlot`). The #12 ordering guard compares slots **lexicographically** — a producer using another format silently breaks out-of-order protection.
3. **Transition seam (#12) + default pipeline:** `MonitorCheckDeps.onTransition` fires **exactly once per check result**, after the state CAS commits. The DEFAULT pipeline (when `onTransition` is not injected) is `logTransitionEvent → handleIncidentLifecycle → handleNotificationIntents` — **order matters**: intents anchor on the incident the previous listener just persisted. An injected `onTransition` (tests) REPLACES the whole pipeline. Listeners must be idempotent keyed by `checkId` and never throw past the seam — throws are isolated and logged (`state.transition_listener_failed`) because a propagated throw retries the message into the duplicate-skip and loses the event forever.
4. **Evaluator gates** (`services/state-evaluation.ts`): evaluation runs only for results with `affects_state=1 && maintenance_excluded=0 && status != paused`. Manual and maintenance results bypass state/counters/incidents/notifications by construction — don't add special cases downstream.
5. **Transition types:** `down` | `recovered` | `up`. `up` = unknown→up (§12.5) and must NOT trigger RECOVERED notifications. `down` events carry `failureSequenceStartedAt` + `reasonCode` → incident `first_failure_at`/`open_reason_code`.
6. **CAS on D1:** `casUpdateMonitorState(db, monitorId, expectedVersion, patch)` — drizzle skips `undefined` values in `.set()` (used for last_success_at/last_failure_at). `db.batch()` requires a **non-empty tuple**: destructure `const [first, ...rest]` and spread.
7. **Test harness:** each test file gets its own miniflare D1 with committed migrations (`createTestDb()`); **within a file the D1 is shared**, and because check ids are deterministic per slot, colliding slots across tests trip #9's duplicate-skip instead of what you meant to test — use unique slots/ids per test. For time-based fixtures (maintenance windows, heartbeats) insert offsets from `Date.now()`, not raw epoch ms. When you ADD a migration, bump the `expect(paths.length).toBe(N)` guard in api-clients/api-notifications/db-schema tests. **D1 enforces FKs in both directions** — you cannot seed an orphaned row (e.g. a notification event with a missing target) to test defensive branches.
8. **Housekeeping is DONE (was the stub era):** all six queue types have real handlers; the DLQ is silent in steady state. **Rollup ordering race neutralized:** daily rollup (00:06) may consume before the 23:xx hourly (00:05) — harmless because #18 computes daily from raw `check_results`, NEVER sums hourly rows. **Window law:** eligibility `source='scheduled' AND maintenance_excluded=0 AND affects_state=1` (§26) is copied verbatim into rollups AND uptime — keep it identical everywhere. Windows are `[start, end)` on the timestamp column with lexicographic ISO comparisons. **Daily downtime semantics (#18 choice):** `incident_count` = incidents opened in the window; `downtime_ms` = overlap of `[opened_at, resolved_at)` with the day, open incidents clipped to window END (never "now") → recomputes are byte-identical; incident-only monitors get NO rollup row (absence = no_data for uptime).
9. **Email durability model (#17):** intent rows are created BEFORE jobs are enqueued (§9.6); the send handler's retryable catch spans lookup + render + send (any throw after the `sending` claim returns the row to `pending` — never strands a row); enqueue failure after insert marks the claimed rows `failed` (visible) since the seam never re-fires. **Known residual:** isolate eviction mid-send leaves `sending` stuck and redeliveries ack (choosing §37.3 no-double-send over at-least-once) — a stale-`sending`/stale-`pending` reconciler is a natural #18/#19 housekeeping addition.
10. **Incident semantics:** `outage_duration_ms` is anchored on `opened_at` (threshold crossing), NOT `first_failure_at` (sequence start) — consistent with the #5 disable path. If #18's `downtime_ms` needs sequence-anchored downtime, that's a decision to surface. `monitor_state.open_incident_id` is maintained WITHOUT bumping `state_version` (the machine owns versions).
11. **API conventions:** Hono routes in `routes/*`, `parseJsonBody(c, zodSchema)`, `parseQuery(c, zodSchema)`, `ApiError` categories (validation 400 / not_found 404 / conflict 409 / rate_limited 429 — `new ApiError("rate_limited", ...)`), envelope `{ data }` or `{ error }`; paginated lists use `{ data, pagination: { total, limit, offset } }` (introduced by `/api/incidents` — reuse for checks/uptime/dead-letters). `recordAudit` on every mutation; Access actor via `c.get("actorEmail")`.
12. **Env/queue adapter:** production `Queue` binding ↔ `QueueLike` via `queueBindingToQueueLike`. `defaultRegistry(checkerDeps, notificationDeps)`; tests inject recording fakes `{ send, sendBatch }` (the helper's default is a silent no-op). `EMAIL?: SendEmail` is optional in `Env` — the send handler fails loudly (row → `pending` + `last_error` → retry → DLQ) when the binding is absent at runtime; tests inject `notificationDeps.sendEmail`.
13. **Healthz semantics (#11):** a never-written heartbeat (missing row or NULL field) is fresh-unknown → `ok` (bootstrap grace, non-flapping by construction); an existing-but-stale timestamp → `degraded`; unparseable → degraded (fail-closed). Response is EXACTLY `{"status":"ok"|"degraded"}` — single field. NOTE: /healthz does NOT yet monitor `last_cleanup_at` freshness (flagged in #19's review; candidate follow-up).
14. **Retention/uptime var coupling (#19/#20):** `RAW_CHECK_RETENTION_DAYS`/`HOURLY_RETENTION_DAYS`/`DAILY_RETENTION_DAYS` (wrangler `vars`, strings) are parsed by the SHARED `parseRetentionDays` in `services/retention.ts` — `/^\d+$/`, fail-loud on garbage (retry → DLQ), §18 defaults when absent. The uptime raw→rollup switchover derives from the same parser so retention and uptime cannot disagree. Documented assumption: HOURLY_RETENTION_DAYS (90d) must cover a window's rollup span; no daily_rollups fallback (see services/uptime.ts header).
15. **Uptime blend semantics (#20):** switchover is floored to the hour — rollups own hours strictly before it, raw owns `[switchover, now]`; the window's first (partial) hour participates WHOLE (a mid-hour window start never drops that hour's checks). Exact rollup↔raw agreement therefore holds only for hour-aligned fixtures (§32.1 fixtures align to hours). Weighted counts summed at full precision; rounding to 2 decimals happens ONCE, in `computeUptime` — consumers must not re-round. `source: "rollup"` is unreachable for now-anchored windows (kept for §24 wording).
16. **D1 facts learned the hard way:** `db.run(sql…)` returns `meta.changes` (used for exact DELETE counting in #19's batch loop); row-value `IN` works for composite keys; D1 caps ~100 bound params/statement — tests seed in chunks of ≤6 check rows; `db.batch()` needs a non-empty tuple (destructure `[first, ...rest]`, spread).
17. **Lint:** `@typescript-eslint/no-unused-vars` is an error (watch arrow-function listener bodies — `(e) => arr.push(e)` returns a number and fails the `void` listener type; use a block body). LF/CRLF warnings on Windows are noise. Long miniflare seed loops need per-test timeouts (`it("…", fn, 30000)`). The react-hooks compiler lint ALSO errors on `Date.now()` during render — anchor "now" to `query.dataUpdatedAt` instead (maintenance page).

---

## 3b. UI-era contracts & gotchas (#21–#25, read before UI work)

1. **Validation SSOT works cross-project:** `src/lib/monitor-form.ts` and `src/lib/maintenance-form.ts` import the worker's zod schemas (`worker/lib/monitor-schema.ts`, `worker/lib/maintenance-schema.ts`) — both are environment-agnostic (zod + URL/Intl only). STRUCTURALLY FRAGILE: any DOM/workerd-specific import added to those worker modules breaks the other tsconfig project. DTO types are NOT shared — `src/types/*.ts` mirrors are deliberate (disjoint lib universes), pinned by the api-* test contracts.
2. **UI forms = pre-flight, server = authority:** client-side validation runs the same schemas, but every submit still handles the §38 error envelope — map `error.details[]` (`{path, message}`) back onto form fields (`serverFieldErrors` in monitors-form), and render `category` + `requestId` in the banner.
3. **Envelope-level fetch mocks in jsdom tests:** handler chains must (a) fail LOUDLY on unexpected calls (`throw new Error("unexpected API call")`), (b) give every handler its OWN destructured `{method, url, body}` params (a closure over the mock's local `body` throws ReferenceError AFTER the call was recorded — assertion on recorded calls still passes, masking it), (c) be stateful for invalidate→refetch flows (mappings PUT → GET must return the new set).
4. **jsdom/testing-library traps:** `getByText` sees only an element's DIRECT text nodes — for section titles with nested count spans, match `getByRole("heading", {name: …})` (accessible name includes descendants). JSX collapses whitespace between expression and element — `{name} <span>{email}</span>` renders with NO space; label queries must use looser regexes. Dependent queries gate on `enabled: !!parent`; pages reading `useParams` MUST be rendered inside a `<Route>` in tests.
5. **Recharts:** explicit `width/height` (NO ResponsiveContainer — jsdom has no layout), `isAnimationActive={false}` (jsdom lacks getTotalLength), `<Legend />` gives the series a text name. The detail route is `React.lazy`'d so the ~109 kB gzip chart chunk stays off the eager bundle (main bundle unchanged). Maintenance overlays are BRACKETED by surrounding plotted points (`overlayRegionsForPoints`) — maintenance checks carry no response time, so windows often contain zero plotted points and naive "points inside window" logic renders nothing.
6. **Deep links are contracts:** `/monitors/:id` (#24) and `/incidents/:id` (#25) are embedded in #17 alert emails — route shapes must never change; both render 404 cards with requestId for dead ids.
7. **Timezones:** persisted = ms-precision UTC; displayed = `Atlantic/Cape_Verde` (§27.8). `src/lib/datetime-local.ts` does UTC↔datetime-local wall conversion (two-pass offset; midnight-crossing pinned by tests). Anchoring "now" in render: use `query.dataUpdatedAt`, never `Date.now()`.
8. **No destructive UI anywhere:** archive/cancel/delete/resolve are two-click confirm guards; archived rows/clients/windows are read-only with explanatory copy. Noted follow-ups: no un-archive path for archived clients (API supports `PATCH {active:true}`); TargetForm email validation is a local regex (extracting worker/lib/notification-schema.ts would complete the SSOT pattern).
9. **Heartbeat freshness (#26) is ONE law:** `worker/lib/heartbeat.ts` — `heartbeatStatus` (fresh | stale | never_run; null = never_run = bootstrap grace; unparseable = stale, fail-closed) + limits (scheduler 3m, consumer 10m, hourly rollup 2h, daily rollup 26h, cleanup 26h — derived from the deterministic #12 slots). /healthz collapses never_run → fresh; GET /api/system shows all three states. Change limits in ONE place.
10. **Bulk import (#27) commit policy:** validate the WHOLE file first (shared schema + §10.9 header check + body/method conflict per row) → create valid unique rows → SKIP probable duplicates (client+url+method) with a pointer (flagged, not duplicated — export→import is idempotent). Clients referenced by NAME/slug in canonical rows, case-insensitive. Mid-flight create failures become row results (partial commit stays visible). Export = same shape incl. requestBody, headers sanitized; non-archived only. Don't raise MAX_IMPORT_ROWS without budgeting D1's per-request query cap (~5 queries/created row).
11. **Bundle:** the Recharts detail page is `React.lazy` (separate ~109 kB gzip chunk); the main bundle is ~505 kB (145 gzip) and `chunkSizeWarningLimit: 600` is a DOCUMENTED decision in vite.config.ts, not a mute — revisit if the main bundle grows meaningfully.


---

## 4. Remaining work — #28 (afk), then STOP for HITL (#29–#31)

**#28 is the last autonomous issue** (production deploy workflow + final wrangler.jsonc + smoke-test script). **#29–#31 are `hitl` issues — they need the human owner. Do not start them autonomously; when the chain reaches them, stop and report.** Full specs live in `gh issue view NNN` — do not create new GitHub issues; these exist.

Cross-cutting notes only the current code knows:

- **APIs the UI consumes are all live:** monitors CRUD + `POST /:id/check` (202) + `GET /:id/uptime?window=24h|7d|30d|90d`, incidents (open-first paginated + `/api/monitors/:id/incidents`), maintenance, notification targets + monitor mappings (`GET/PUT /api/monitors/:id/notification-targets`), clients, `GET /api/dashboard`, and `GET /api/monitors/:id/checks` (#24, paginated history).
- **Pagination convention** (from `/api/incidents`): `{ data, pagination: { total, limit, offset } }` — checks/dead-letters reuse it; limit hard max is 200.
- **Deep links already emitted in emails** (#17): `${APP_ORIGIN}/monitors/:id` and `${APP_ORIGIN}/incidents/:id` — both are REAL pages now; keep the shapes stable.
- **Error envelopes** (§38): `{ error: { category, message, requestId, details } }` — build UI error handling around `category`, not messages; `details[]` maps to form fields.
- **Auth in dev:** `APP_ACCESS_MODE=local` trusts `X-Dev-Access-Email`; production is Access JWT (`access` mode, fail-closed `locked` default). UI ships before provisioning (#29) — keep local mode working.
- **`GET /:id/uptime` validation quirk:** invalid window on an unknown monitor returns 400 (validation runs before the 404) — deliberate, tested; don't "fix" asymmetry without a reason.
- **System heartbeats for #26's system page:** `system_state` row has `last_scheduler_at`, `last_queue_consumer_at`, `last_hourly_rollup_at`, `last_daily_rollup_at`, `last_cleanup_at` (the last one is NOT yet surfaced in /healthz — candidate follow-up). Dead-letter rows come from `dead_letter_events` (DLQ consumer persists them). The #22 dashboard already carries the heartbeat chip (`{status, checks:{d1,scheduler,consumer}}`).
- **APIs live as of the end of the UI era:** everything in §3b plus GET /api/system, GET+PATCH /api/dead-letters, GET /api/notification-events, POST /api/monitors/import, GET /api/monitors/export. Every §38 envelope convention holds.
- **For #28:** wrangler.jsonc still has placeholders (real database_id + Access team domain/AUD land in provisioning #29 — check the file header note); APP_VERSION var exists and should be bumped/automated at deploy; `run_worker_first` + SPA fallback are already wired; APP_ACCESS_MODE must ship as `access` (fail-closed `locked` default remains safe). The external smoke gate depends on /healthz's strict two-field contract (§19).
- **HITL gate:** #29 needs real Cloudflare credentials/decisions; #30 is the owner's rollout plan; #31 is an EXTERNAL repo watching /healthz. Autonomous work must not preempt owner choices.

Sequence: **#28**, then **STOP — hand #29–#31 to the owner**.
