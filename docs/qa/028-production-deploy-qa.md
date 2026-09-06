# QA Report — #28 Production deploy workflow + final wrangler.jsonc + smoke script

**Date:** 2026-09-06 · **Target:** PR #60 as merged to main (`6cb8522`) · **QA pass:** formal morabeza-qa (post-merge, evidence-based) · **Prior gates:** morabeza-reviewer (READY-WITH-FIXES → all fixes landed pre-merge), CI, full local suite.

---

### 1. What was tested

The five acceptance criteria of issue #28, with emphasis on the parts CI *cannot* exercise: the deploy workflow's decision logic, the smoke script against a **live server runtime** (not just fetch fixtures), and real-config validation. Environment: Windows/Git Bash dev machine, `pnpm preview` (workerd via Cloudflare Vite plugin) as the live target. No production resources exist yet (#29) — nothing was deployed.

### 2. Acceptance criteria results

| AC | Result | Evidence |
| --- | --- | --- |
| 1. Config validation passes with placeholder D1 id documented; no tokens in repo | **PASS** | `pnpm deploy:dry-run` exit 0 on main (build → `wrangler deploy --dry-run`, redirected dist config, all §31 vars echoed incl. `APP_ACCESS_MODE:"access"`, traces 5%, placeholder id intact); token grep over `wrangler.jsonc`/`.github/workflows`/`scripts`/`public` clean (only `secrets.*` references); placeholder documented in file comment + RUNBOOK §1 |
| 2. Deploy workflow dispatch-only, `production` env approval; never on push/merge | **PASS** | GitHub parsed the workflow (`gh workflow list` → "Deploy production" active — authoritative YAML validity); grep: sole trigger `workflow_dispatch` (no `push:`/`pull_request:` anywhere); `environment: production`; job-level `if: github.ref == 'refs/heads/main'` backstop; `concurrency: deploy-production` with `cancel-in-progress: false`; `permissions: contents:read, checks:read` |
| 3. Security headers present on responses (tests for nosniff/CSP/Referrer-Policy/frame-ancestors) | **PASS** | Tests in suite (`security-headers.test.ts`): exact statuses 503/404/401 across the three worker response paths + byte-identical `public/_headers` lockstep; **live evidence**: `curl -i localhost:4173/healthz` returned all three headers byte-exact and workerd logged `Parsed 1 valid header rule` (assets layer picked up `_headers` from `dist/client/`) |
| 4. Smoke script runs locally against a target URL, reporting pass/manual-needed per item | **PASS** | Real run `pnpm smoke http://localhost:4173` against the workerd preview: healthz PASS, worker-security-headers PASS, anonymous-api PASS (401), anonymous-root FAIL (200 — no Access exists locally, the exact condition the gate exists to catch) → exit 1 with "do not declare production ready"; 12 manual items printed; `--json` output machine-parseable (validated by piping through a JSON parser) |
| 5. CI green; local dev unaffected by production config | **PASS** | Main CI success on PRs #60 and #61; local: 454/454 tests, lint 0 errors (6 pre-existing warnings), typecheck green; preview boots fine with NO `.dev.vars` present (API fails *closed* 401 in access mode — safe; healthz fine) |

### 3. Scenarios tested

- **CI-gate decision logic** (the one piece CI hasn't executed): the workflow's exact jq program ported to a faithful harness, 11 fixtures — all-green→DEPLOY; in_progress/queued→WAIT; timed_out/cancelled/startup_failure/action_required/stale→ABORT; neutral/skipped→pass; zero check-runs→WAIT-then-abort; multi-page aggregation→DEPLOY; mixed-page pending→WAIT. 11/11 correct.
- **Smoke happy path**: healthz 200 `{"status":"ok"}` + headers + blocked API (3 PASS).
- **Smoke failure path (live)**: anonymous `/` reachable → FAIL → exit code 1 (deploy job would fail).
- **Smoke CLI**: usage-missing-arg → exit 2; bad URL → exit 2 with clear error; `--json` keeps stdout pure JSON (RESULT banner goes to stderr).
- **Live header verification**: raw `curl -i` on /healthz against workerd — CSP byte-exact vs `CONTENT_SECURITY_POLICY`, `nosniff`, `no-referrer`, plus `cache-control: no-store` and request id (existing contracts intact).
- **AC1 validation**: full `pnpm deploy:dry-run` on merged main.
- **Regression**: full suite (454/454) on main post-merge.

### 4. Findings

1. **LOW · deferred — jq expression not executed on a real jq binary.** `node-jq` could not be installed in this environment (postinstall download blocked); verification is a faithful reimplementation (11/11 fixtures) plus static review (only core jq: `map`-free `.[].check_runs[]`, `select`, `length` — stable jq-1.6+ syntax; ubuntu-latest ships current jq). **Fail-safe direction:** under `set -euo pipefail`, a malformed expression fails the gate step, which can only BLOCK a deploy — it cannot allow an unsafe one. Authoritative exercise happens at the first real dispatch (#29).
2. **LOW · verified, by design — smoke `anonymous-root` fails outside production.** Any Access-less environment (local preview, workers.dev) returns 200 on `/` and the script correctly exits 1. This is the intended gate behavior, not a defect; RUNBOOK documents that the script targets the Access-protected origin.
3. **LOW · deferred (review M1) — CI-gate wait ceiling is 10 min (30×20s).** A slower CI run aborts a legitimate deploy attempt (fail-loud; re-dispatch). Accepted; noted here so nobody mistakes it for a hang.
4. **INFO — QA harness self-correction during testing:** the first jq-fixture run flagged a false FAIL caused by a wrong fixture (conclusion vs status mix-up) in the harness itself, not in the workflow; corrected and re-run. No product change.

### 5. Severity summary

Critical: 0 · High: 0 · Medium: 0 · Low: 3 (1 deferred-verification, 2 by-design/accepted) · Info: 1. No finding blocks go-live or the #29 handover.

### 6. Regression notes

- `worker/app.ts` gained one root middleware — the touched-area suites (app, healthz, all api-*) are green; healthz's strict two-field contract re-verified live (`{"status":"ok"}` exactly).
- No migrations touched → no migration-count guard bumps needed (db-schema/api-clients/api-notifications guards unaffected, suite confirms).
- Client bundle unchanged (build output identical sizes; headers not in bundle path). UI untouched.
- No reusable gotcha beyond those already recorded in HANDOFF §3c (two-path header law, GITHUB_ENV same-step trap, `.dev.vars` requirement).

### 7. Deferred issues

- Real-jq execution of the CI-gate filter → first production dispatch (#29, owner). Non-blocking per Finding 1's fail-safe analysis.
- 10-min gate ceiling (Finding 3) → revisit only if it bites; one-line change.

### 8. Final verdict

**PASSED WITH DEFERRED LOW-SEVERITY ISSUES** — every AC is verified with direct evidence, including live-runtime execution of the smoke gate and byte-exact header checks; the three lows are either by-design or fail-safe deferred verifications that only the owner's first real deploy can complete.

### 9. Next best action

Proceed to CSO/sign-off and hand #29–#31 to the owner with `docs/RUNBOOK.md`. Nothing on main blocks the HITL phase.
