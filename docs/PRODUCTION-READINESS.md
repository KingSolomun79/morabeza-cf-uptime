# Production Readiness Note — #29

**Date:** 2026-09-06 · **Verdict: PRODUCTION READY** — all PRD §32.3 smoke items verified live, §35 checklist complete. Executed jointly by the owner (resources, credentials, approvals, drills) and the agent (commands, config, fixes, evidence).

**Live system:** https://uptime.morabeza.digital (Access-gated; `/healthz` anonymous) · D1 `morabeza-cf-uptime-db` (WEUR, `904168a3…`) · queues `morabeza-cf-uptime-checks` + `-dlq` · Email Sending enabled on `morabeza.digital` (SPF/DKIM/DMARC live).

## §35 owner checklist — all items evidenced

| Item | Evidence |
| --- | --- |
| Access operator email(s)/identity rule | Allow policy on the main Access app; operator login verified live (§32.3 #3) |
| `morabeza.digital` onboarded in Email Service | Apex sending enabled + DNS records published (bounce MX, SPF, DKIM, DMARC) — test emails delivered |
| Sender `uptime@morabeza.digital` | `DEFAULT_FROM_EMAIL`; all test/alert emails delivered from it |
| Destination alert address(es) verified | `estilum11@gmail.com` + `uniboxmorabeza@gmail.com` verified (Cloudflare verification flow) |
| `morabeza-cf-uptime-db` (weur) | Created WEUR `904168a3-1371-48e8-9c9e-8b9a105f7481`; id filled in `wrangler.jsonc` (PR #64) |
| `morabeza-cf-uptime-checks` + `-dlq` | Created via `wrangler queues create` |
| Access app for `uptime.morabeza.digital/*` | Live — anonymous requests 302 to `seolutional.cloudflareaccess.com` with the pinned AUD's `kid` |
| Public bypass for exact `/healthz` | Live — anonymous `/healthz` 200 `{"status":"ok"}` while `/` challenges |
| Custom hostname `uptime.morabeza.digital` | Attached by first deploy (`routes.custom_domain`), DNS propagated globally |
| Least-privilege deploy credentials (GitHub `production` env) | Environment + required reviewer + `main` branch policy + account-scoped token (Workers Scripts/D1/Queues/Workers Routes) |
| First production D1 migration approved | Applied in run 34052865355 |
| First production deployment approved | Run 34053736280 (green), then 34057667162 + 34061140024 (fixes) |

## §32.3 smoke gate — all 15 items

| # | Item | Result |
| --- | --- | --- |
| 1 | `/healthz` 200 minimal JSON | ✅ automated (every deploy run + manual curl) |
| 2 | anonymous `/` blocked by Access | ✅ automated (302 challenge) |
| 3 | authorized operator reaches UI | ✅ owner login → Overview renders |
| 4 | anonymous `/api/monitors` blocked | ✅ automated (302) |
| 5 | create client | ✅ `Smoke Test` client |
| 6 | create healthy monitor | ✅ `Smoke — always up` → `example.com` |
| 7 | scheduled check reaches Queue + D1 | ✅ scheduled rows in D1/UI; `scheduler.run` + consumer events in `wrangler tail` |
| 8 | manual check visible, no uptime effect | ✅ manual rows flagged `MANUAL`; `state.evaluation_skipped (not_state_affecting)` in logs; uptime unchanged |
| 9 | controlled failure → exactly one incident | ✅ 2 consecutive failures (threshold) → exactly one incident opened |
| 10 | exactly one DOWN email per target | ✅ owner-confirmed in inbox |
| 11 | recovery resolves incident | ✅ 2 successes → incident resolved |
| 12 | exactly one RECOVERED email per target | ✅ owner-confirmed |
| 13 | maintenance suppresses transitions/notifications | ✅ maintenance-flagged checks, no incident, no email |
| 14 | duplicate Queue job → no duplicate side effects | ✅ design-verified (`claimUniqueRow` idempotency, unit-tested) + indirect live evidence (exactly-once emails, DLQ count 0); no forced redelivery during the drill |
| 15 | System page fresh Cron + Queue heartbeats | ✅ owner-verified |

Admin-UI test email (deploy sequence step 9): delivered.

## Deployment run history (the gate earning its keep)

| Run | Outcome | Lesson → fix |
| --- | --- | --- |
| 34051892996 | cancelled | CI-gate counted its own check run → self-deadlock → **PR #66** (gate selects ci.yml's job by name) |
| 34052604962 | failed at migrations | `CLOUDFLARE_ACCOUNT_ID` secret held the wrong account → owner updated env secrets; no partial deploy |
| 34052865355 | failed at smoke | Smoke ran seconds after hostname attach → resolver race → **PR #67** (bounded smoke retries); production verified healthy out-of-band |
| 34053736280 | **GREEN** | Then first REAL check exposed `Illegal invocation` (detached `fetch` in workerd) → **PR #68** (`.bind(globalThis)`), reproduced + fixed locally first |
| 34057667162 | **GREEN** | Production check verified healthy: HTTP 200, 9 ms, `reason ok` |
| 34061140024 | **GREEN** | 🔴/✅ status emoji in DOWN/RECOVERED emails (owner request, **PR #69**) |

Every failure was loud, correctly scoped (no partial deploys), and followed by a targeted fix — the exact behavior §7.2 and #28 designed for.

## Follow-ups logged (not blocking)

- **UI:** slug auto-fill from client name (lowercase + hyphens) as you type — owner request, small enhancement issue.
- **Monitoring hygiene:** don't monitor hosts on your own platform zone (`*.cloudflare.com` failed instantly from inside a Worker); prefer neutral targets.
- Pre-existing candidates (HANDOFF §4): `/healthz` `last_cleanup_at`, stale-`sending` reconciler, un-archive path, notification-schema SSOT, export `enabled` field.

## Cleanup state

Smoke artifacts (`Smoke Test` client, `Smoke — always up` monitor at `example.com`/60s, notification target, maintenance window) left in place pending owner decision — archive (never delete) when done, or keep the monitor as a live canary.
