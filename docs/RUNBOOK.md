# Production Runbook — Morabeza CF Uptime

**Audience:** the human owner executing issue #29 (HITL provisioning + first deploy). Issue #28 shipped everything that does not require real Cloudflare resources or credentials; this document is the manual companion to that automation. Values below are deliberately not invented (PRD §35) — fill them in as you provision.

**Ground rule (PRD §7.2):** production deployment is a human-approved action. Nothing deploys automatically — not on merge, not on push, not on a schedule. Every production deploy goes through the `Deploy production` workflow, which requires your approval on the `production` GitHub environment.

---

## 1. One-time provisioning checklist (PRD §35)

Work through these before the first deploy. The coding agent cannot do any of this for you.

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

Repo-side actions that pair with provisioning:

1. **Fill the D1 id.** After `wrangler d1 create morabeza-cf-uptime-db` (weur hint), replace `OWNER_TO_FILL_AFTER_CREATION` in `wrangler.jsonc` `d1_databases[0].database_id` with the real id. Until then the placeholder passes local validation (`pnpm deploy:dry-run`) but the deploy workflow **fails loudly on purpose** — no half-configured deploys.
2. **GitHub `production` environment.** Repo Settings → Environments → create `production` with **required reviewers** (you) so `workflow_dispatch` runs wait for approval. Add environment secrets (least privilege — Workers deploy + D1 + Queues only, PRD §31):
   - `CLOUDFLARE_API_TOKEN` — template `Edit Cloudflare Workers`, scoped to the account, with D1 and Queues permissions;
   - `CLOUDFLARE_ACCOUNT_ID`.
3. **Access runtime bindings (if you want the AUD pinned).** `ACCESS_TEAM_DOMAIN` / `ACCESS_AUDIENCE` are optional `Env` fields; set them as deploy-time vars/secrets (dashboard or `wrangler deploy --var`), never in the repo (PRD §31). Access mode without a team domain fails closed (`Access is not configured`), so the API cannot be accidentally opened.
4. **Queues + Email.** Creating `morabeza-cf-uptime-checks` / `-dlq` and onboarding Email Service are dashboard/CLI actions; the `wrangler.jsonc` bindings already reference those exact queue names and the `EMAIL` send binding.

## 2. Deploying (PRD §7.2)

**Automated (the workflow does 1–4):**

1. **Verify clean CI** — the job queries check-runs on the exact dispatched SHA and refuses to deploy unless every check run is green (waits for pending runs; aborts on any failure or if the commit has no CI runs).
2. **Apply D1 migrations (remote, production DB)** — `pnpm wrangler d1 migrations apply morabeza-cf-uptime-db --remote`. Runs BEFORE deploy; a failed migration aborts before any new code ships.
3. **Deploy Worker + static assets** — `pnpm build` happened earlier in the job; `pnpm wrangler deploy` uses the Vite output config. `APP_VERSION` is stamped `<pkg-version>+run-<run>-<sha7>` via `--var`, visible on the System page (`GET /api/system`).
4. **Smoke tests (§32.3 automated subset)** — `node scripts/smoke.mjs "$SMOKE_BASE_URL"`; a failing check fails the job.

**To run:** Actions → **Deploy production** → Run workflow → (optionally override the smoke base URL) → approve the `production` environment gate when prompted.

**Manual (you walk through after every deploy — the workflow cannot):**

5. Verify `/healthz` — automated smoke already did (200 + `{"status":"ok"}`); eyeball it once for the first deploy.
6. Verify the Access-protected UI — log in and load the Overview page.
7. Verify the Cron heartbeat — System page scheduler heartbeat turns fresh within ~5 minutes.
8. Verify the Queue heartbeat — System page consumer heartbeat fresh; DLQ count 0.
9. Send a test email from the admin UI (Notifications → target → Send test).

## 3. Smoke tests (PRD §32.3)

```bash
pnpm smoke https://uptime.morabeza.digital
```

The script prints PASS/FAIL per automated item and enumerates the manual ones; exit code 1 = an automated check failed (the deploy job inherits that failure).

Automated items — read-only GETs only:

| Item | Check |
| --- | --- |
| §32.3 #1 | `/healthz` → 200, body exactly `{"status":"ok"}` (a `degraded` 503 fails the gate) |
| §32.3 #2 | anonymous `GET /` → blocked/challenged by Access (3xx/401/403) |
| §32.3 #4 | anonymous `GET /api/monitors` → blocked (3xx/401/403; a 404 also fails — the route must exist behind the gate) |
| §29.11–14 | CSP (`frame-ancestors 'none'`), `nosniff`, `Referrer-Policy` present on `/healthz` |

Manual items #3, #5–#15 (operator login, client/monitor creation, controlled failure + exactly-one-incident/email behavior, maintenance suppression, duplicate-delivery idempotency, fresh heartbeats) are printed by the script with how-to-verify steps. **Production is not "ready" until every manual item has been walked through once** — for the first deploy do all of them; for routine deploys, #1/#2/#4 plus spot-checking the System page is proportionate.

## 4. Rollback

Deployments are versioned (Workers Versions). To roll back a bad deploy:

```bash
pnpm wrangler rollback          # interactively pick the previous version
```

Migrations are append-only; if a rollback crosses a migration, assess schema compatibility before/while rolling back (the #28 workflow orders migrations BEFORE deploy so a failed migration never leaves new code on an old schema).

## 5. Operational notes

- **No auto-deploy:** the workflow has `workflow_dispatch` as its only trigger, guarded by `concurrency group: deploy-production` (serialized deploys) and the environment approval gate.
- **No tokens in the repo** (PRD §31): deploy credentials live only as `production` environment secrets; `wrangler.jsonc` carries non-secret vars only.
- **Local dev is unaffected by production config:** `wrangler.jsonc` now ships production values (`APP_ACCESS_MODE=access`, production `APP_ORIGIN`, etc.); copy `.dev.vars.example` → `.dev.vars` to override them locally (PRD §7.1). CI and tests never touch production resources.
- **Config validation without credentials:** `pnpm deploy:dry-run` (build + `wrangler deploy --dry-run`) validates the full production config locally, placeholder D1 id included.
- **Observability:** logs enabled + traces at 5% head sampling (§31). The #26 System page and `/healthz` are the first place to look when a smoke item fails.
