#!/usr/bin/env node
/**
 * Production smoke tests (issue #28; PRD §32.3).
 *
 * Runs the AUTOMATABLE subset of the §32.3 checklist against a deployed base
 * URL and reports every remaining item as manual-needed — production is only
 * "ready" when the manual walk-through (docs/RUNBOOK.md) passes too.
 *
 * Automated here:
 *   #1  /healthz returns 200 and minimal JSON ({status:"ok"} exactly)
 *   #2  anonymous request to / is blocked/challenged by Access
 *   #4  anonymous request to /api/monitors is blocked
 *   +   §29.11–14 security headers present on the anonymous Worker response
 *       (/healthz is the only Worker response reachable without identity)
 *
 * Usage:
 *   node scripts/smoke.mjs <base-url>            e.g. https://uptime.morabeza.digital
 *   pnpm smoke <base-url> [--json]
 *
 * Exit codes: 0 = all automated checks passed (manual items still pending),
 * 1 = one or more automated checks failed, 2 = bad usage.
 * The checks are read-only GETs; they never mutate production data.
 */
import { pathToFileURL } from "node:url";

/** Statuses that mean "Access (or the locked API) refused an anonymous request". */
const ACCESS_BLOCK_STATUSES = new Set([301, 302, 303, 307, 308, 401, 403]);

export function isAccessBlocked(status) {
  return ACCESS_BLOCK_STATUSES.has(status);
}

/** The §29.11–14 headers every Worker-generated response must carry. */
export const REQUIRED_SECURITY_HEADERS = [
  { name: "content-security-policy", mustContain: "frame-ancestors 'none'" },
  { name: "x-content-type-options", mustContain: "nosniff" },
  { name: "referrer-policy", mustContain: null },
];

export function missingSecurityHeaders(headers) {
  const missing = [];
  for (const { name, mustContain } of REQUIRED_SECURITY_HEADERS) {
    const value = headers.get(name);
    if (value === null || (mustContain !== null && !value.includes(mustContain))) {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * The §32.3 items that CANNOT be automated from the outside (identity-bound
 * or side-effecting) — printed by the CLI and verified by the manual
 * walk-through in docs/RUNBOOK.md.
 */
export const MANUAL_CHECKS = [
  {
    id: "#3",
    title: "Authorized operator reaches the UI",
    how: "Log in through Cloudflare Access and load / — the Overview page renders.",
  },
  {
    id: "#5",
    title: "Create client",
    how: "In the UI: Clients → New client (e.g. the seeded Morabeza client already exists; add one if needed).",
  },
  {
    id: "#6",
    title: "Create healthy monitor",
    how: "In the UI: Monitors → New monitor pointed at a known-good https URL.",
  },
  {
    id: "#7",
    title: "Scheduled check reaches Queue and D1",
    how: "Wait for the next minute slot; the monitor detail page shows fresh checks (System page heartbeats green).",
  },
  {
    id: "#8",
    title: "Manual check appears but does not affect uptime",
    how: "Run check-now on the monitor; the check is listed as manual and uptime windows are unchanged.",
  },
  {
    id: "#9",
    title: "Controlled failure opens exactly one incident",
    how: "Point the monitor at a failing URL; after threshold crossings exactly one incident opens (§12.3).",
  },
  {
    id: "#10",
    title: "Exactly one DOWN email per target",
    how: "Each notification target receives exactly one DOWN email (§17 idempotency).",
  },
  {
    id: "#11",
    title: "Controlled recovery resolves the incident",
    how: "Restore the URL; after recovery thresholds the incident resolves (§12.4).",
  },
  {
    id: "#12",
    title: "Exactly one RECOVERED email per target",
    how: "Each target receives exactly one RECOVERED email.",
  },
  {
    id: "#13",
    title: "Maintenance suppresses transitions/notifications",
    how: "Create an active maintenance window; failures during it must not open incidents or send email (§14).",
  },
  {
    id: "#14",
    title: "Duplicate Queue job creates no duplicate side effects",
    how: "Observability logs: a redelivered monitor.check message acks with no new incident/email (§16.4).",
  },
  {
    id: "#15",
    title: "System page shows fresh Cron and Queue heartbeats",
    how: "System page: scheduler + consumer + rollup heartbeats read fresh (§27.10).",
  },
];

export function normalizeBaseUrl(raw) {
  const trimmed = String(raw ?? "").trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`base URL must be http(s): ${raw}`);
  }
  return parsed.origin;
}

function check(id, prd, title, status, detail) {
  return { id, prd, title, status, detail };
}

/**
 * Runs the automated §32.3 subset against `baseUrl`. Pure aside from the
 * injected `fetchImpl`, so tests drive it with fixtures.
 */
export async function runSmokeChecks(baseUrl, { fetchImpl = fetch } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const checks = [];

  // §32.3 #1 — /healthz: 200 + minimal JSON. The contract (issue #11) is
  // EXACTLY {"status":"ok"|"degraded"}; anything else fails the smoke gate.
  try {
    const res = await fetchImpl(`${base}/healthz`, { redirect: "manual" });
    let body = null;
    let parseError = null;
    try {
      body = await res.json();
    } catch (err) {
      parseError = err;
    }
    const minimal =
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      body.status === "ok";
    if (res.status === 200 && minimal) {
      checks.push(check("healthz", "§32.3 #1", "/healthz returns 200 minimal JSON", "pass", JSON.stringify(body)));
    } else if (res.status === 503 && body?.status === "degraded") {
      checks.push(
        check("healthz", "§32.3 #1", "/healthz returns 200 minimal JSON", "fail", "healthz reports degraded (503) — heartbeats stale?"),
      );
    } else {
      const detail =
        parseError !== null
          ? `non-JSON body (status ${res.status})`
          : `status ${res.status}, body ${JSON.stringify(body)}`;
      checks.push(check("healthz", "§32.3 #1", "/healthz returns 200 minimal JSON", "fail", detail));
    }

    // §29.11–14 — security headers on the one anonymous Worker response.
    const missing = missingSecurityHeaders(res.headers);
    checks.push(
      missing.length === 0
        ? check("worker-security-headers", "§29.11–14", "security headers on /healthz", "pass", "CSP/nosniff/Referrer-Policy present")
        : check("worker-security-headers", "§29.11–14", "security headers on /healthz", "fail", `missing/invalid: ${missing.join(", ")}`),
    );
  } catch (err) {
    checks.push(check("healthz", "§32.3 #1", "/healthz returns 200 minimal JSON", "error", String(err)));
    checks.push(check("worker-security-headers", "§29.11–14", "security headers on /healthz", "error", "healthz unreachable"));
  }

  // §32.3 #2 — anonymous / must be blocked/challenged by Access.
  try {
    const res = await fetchImpl(`${base}/`, { redirect: "manual" });
    if (isAccessBlocked(res.status)) {
      checks.push(check("anonymous-root", "§32.3 #2", "anonymous / is blocked by Access", "pass", `status ${res.status}${res.headers.get("location") ? ` → ${res.headers.get("location")}` : ""}`));
    } else {
      checks.push(check("anonymous-root", "§32.3 #2", "anonymous / is blocked by Access", "fail", `status ${res.status} — anonymous HTML reachable; Access not enforcing?`));
    }
  } catch (err) {
    checks.push(check("anonymous-root", "§32.3 #2", "anonymous / is blocked by Access", "error", String(err)));
  }

  // §32.3 #4 — anonymous /api/monitors must be blocked.
  try {
    const res = await fetchImpl(`${base}/api/monitors`, { redirect: "manual" });
    if (isAccessBlocked(res.status)) {
      checks.push(check("anonymous-api", "§32.3 #4", "anonymous /api/monitors is blocked", "pass", `status ${res.status}`));
    } else {
      checks.push(check("anonymous-api", "§32.3 #4", "anonymous /api/monitors is blocked", "fail", `status ${res.status} — expected 401/403 or an Access challenge`));
    }
  } catch (err) {
    checks.push(check("anonymous-api", "§32.3 #4", "anonymous /api/monitors is blocked", "error", String(err)));
  }

  return { baseUrl: base, checks, manual: MANUAL_CHECKS };
}

export function automatedPassed(result) {
  return result.checks.every((c) => c.status === "pass");
}

function printReport(result) {
  const lines = [];
  lines.push(`Morabeza production smoke — ${result.baseUrl}`);
  lines.push("");
  lines.push("Automated (PRD §32.3 subset):");
  for (const c of result.checks) {
    const mark = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "ERROR";
    lines.push(`  ${mark}  ${c.id.padEnd(24)} ${c.title} — ${c.detail}`);
  }
  lines.push("");
  lines.push("Manual-needed (walk through in docs/RUNBOOK.md):");
  for (const m of result.manual) {
    lines.push(`  [ ] ${m.id}  ${m.title}`);
    lines.push(`        ${m.how}`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const args = argv.filter((a) => a !== "--json");
  const asJson = args.length !== argv.length;
  const rawUrl = args[0];
  if (!rawUrl) {
    console.error("Usage: node scripts/smoke.mjs <base-url> [--json]");
    return 2;
  }
  let result;
  try {
    result = await runSmokeChecks(rawUrl);
  } catch (err) {
    console.error(String(err));
    return 2;
  }
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(printReport(result));
  }
  if (!automatedPassed(result)) {
    console.error("RESULT: FAIL — automated smoke checks failed; do not declare production ready.");
    return 1;
  }
  console.log("RESULT: PASS (automated) — complete the manual checklist before go-live.");
  return 0;
}

// CLI entry point only — importing the module (tests, tooling) never runs
// checks. exitCode (not process.exit) so piped stdout (CI logs) flushes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
