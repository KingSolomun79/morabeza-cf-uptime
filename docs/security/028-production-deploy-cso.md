# CSO Security Sign-off — #28 Production deploy workflow + final wrangler.jsonc + smoke script

**Date:** 2026-09-06 · **Target:** PR #60 as merged to main (`6cb8522`), QA'd in `docs/qa/028-production-deploy-qa.md` · **Audit type:** AI-assisted CSO sign-off (morabeza-cso). Not a substitute for a professional external security audit.

---

### 1. What was audited

Everything #28 changed: final `wrangler.jsonc` (production exposure flags, vars incl. `APP_ACCESS_MODE=access`), security-header delivery (`worker/lib/security-headers.ts`, `public/_headers`), `.github/workflows/deploy-production.yml` (the new CI/CD trust boundary), `scripts/smoke.mjs`, `docs/RUNBOOK.md`.

### 2. Security scope

Directly touches: **secrets handling** (workflow secret references), **deploy credentials/CI practices**, **auth configuration** (production auth mode now shipped in config), **public exposure** (workers.dev/preview URLs, anonymous `/healthz`), **response security policy** (CSP). Indirectly: D1 migrations execution path (remote apply in the workflow). Payments/webhooks: not present in this system.

### 3. Attack-surface summary

| Surface | Posture after #28 |
| --- | --- |
| Production ingress | Custom hostname only; `workers_dev:false`, `preview_urls:false` (verified in generated deploy config) — no bypass origins around Access. `/healthz` is the single anonymous route: one-field payload (`{"status":"ok"\|"degraded"}`), `no-store`, no version/instance/timestamp disclosure. |
| API auth | Fail-closed chain verified in code AND live (QA): missing var → `locked` (reject all); `access` mode without token → 401 before any other check; `access` without `ACCESS_TEAM_DOMAIN` → "Access is not configured" 500. Local mode unreachable unless someone ships `local` via a reviewed repo change. |
| Deploy pipeline | Dispatch-only; job pinned to `refs/heads/main`; serialized deploys; migrations run before deploy; artifacts are **built fresh inside the approved job from the dispatched SHA** — no CI-artifact download path, so no artifact poisoning. `inputs.app_url` reaches the shell as an **env var**, not an inline interpolation (no script injection). Only GitHub-controlled values (`github.sha`, `github.repository`) are interpolated. Secrets are `production`-environment-scoped and referenced, never echoed; `github.token` is `checks:read`-only. |
| Secrets in repo | None. Grep over shipped config/workflows/scripts: only `secrets.*` references. `database_id` is a documented placeholder; Access team domain/AUD deliberately absent from the repo (owner sets at deploy). |
| Static assets | `public/` contains only `_headers` (declarative, test-pinned byte-identical to the worker module — no injection surface); plugin `.assetsignore` excludes `wrangler.json`/`.dev.vars` from serving; `.dev.vars` lives at repo root and is never in the public-copy path. |
| Smoke script | Read-only GETs, `redirect:"manual"`, no eval/exec, output to stdout/stderr only. CLI-local tool, not a network service. |

### 4. Findings

**M1 · MEDIUM · deferred-by-design to #29, order-critical — the approval gate is inert until the owner configures the `production` environment.** GitHub auto-creates a referenced environment with no protection rules. Until RUNBOOK §1.2 is done, a user with repo write access who dispatches the workflow from `main` deploys without a second human approval. Mitigations already in place: no automatic trigger exists (dispatch-only), main-only job backstop, migrations-before-deploy ordering, serialized deploys. **Remediation (blocking for FIRST DISPATCH, not for this merge): configure the `production` environment with required reviewers + least-privilege `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` before anyone dispatches.** The workflow fails loudly without those secrets, so an accidental early dispatch fails rather than half-deploys. Plainly: do not run "Deploy production" until #29's checklist is done.

**W1 · LOW · watch — third-party actions are tag-pinned (`@v4`), not SHA-pinned** (`actions/checkout`, `pnpm/action-setup`, `actions/setup-node`; same pattern as the pre-existing `ci.yml`). Tag-mutation is a real supply-chain vector for a workflow that holds deploy secrets. Remediation candidate: pin all actions by full commit SHA in both workflows as a small hardening PR (can precede or accompany #29).

**W2 · LOW · watch — smoke prints the Access redirect `Location` into logs.** A compromised origin could return an attacker-chosen Location value that lands in CI log output. GitHub's log viewer renders as sanitized HTML and the script targets the owner's own deployment, so exploitability is exotic; note only. Hardening option: truncate/redact the Location detail.

**I1 · INFO · by design — public degraded/ok signal.** `/healthz` intentionally tells the world whether heartbeats are fresh (PRD §8.2/§19) so the external #31 watchdog can function. Single-field, no-store; accepted product decision.

### 5. Severity summary

Critical: 0 · High: 0 · Medium: 1 (M1, deferred-by-design with order-critical remediation in #29) · Low: 2 (watch) · Info: 1.

### 6. Required remediation

- **Before first production dispatch (owner, #29):** configure `production` environment protections + least-privilege secrets (RUNBOOK §1). This is the only remediation that gates shipping — and it is deliberately #29 scope, not #28 code.

### 7. Watch items

- SHA-pin GitHub Actions in both workflows (W1).
- Redact/shorten smoke Location detail (W2).
- Existing candidate follow-ups unchanged: `last_cleanup_at` in `/healthz`, stale-`sending` reconciler, notification-schema SSOT.

### 8. Final security verdict

**SECURITY OK WITH WATCH ITEMS** — proceed. No finding blocks the merge, the HITL handover, or #29 preparation. The single Medium is an ordering requirement the project already owns (#29's first checklist item), and every auth/exposure default in the shipped config fails closed.

### 9. Next best action

Hand #29–#31 to the owner with `docs/RUNBOOK.md` + this report. Recommended cheap hardening before or alongside #29: SHA-pin actions (W1) and configure the environment gate (M1) in the same sitting.
