/**
 * Issue #22 — GET /api/dashboard (PRD §24, §27.3, §36).
 *
 * Mixed fixture states against real D1. Two layers:
 *  - service tests pin exact aggregates with an INJECTED clock (fixtures
 *    anchored to a fixed NOW — gotcha 7: never mix wall-clock into fixtures);
 *  - a route smoke seeds fixtures relative to Date.now() and asserts the
 *    endpoint contract through the real Hono app.
 *
 * Bounded query budget (§36) is by construction in services/dashboard.ts:
 * six fixed statements + the heartbeat read, regardless of fleet size.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeTestDb, createTestDb, type TestD1 } from "../helpers/d1";
import { getDb } from "../../worker/lib/db";
import { getDashboard } from "../../worker/services/dashboard";
import {
  checkResults,
  clients,
  hourlyRollups,
  incidents,
  maintenanceWindows,
  monitorState,
  monitors,
} from "../../db/schema";

const NOW = "2026-09-06T12:00:00.000Z";

let testDb: TestD1;
let db: ReturnType<typeof getDb>;

async function seedMonitor(opts: {
  id: string;
  clientId: string;
  name: string;
  status?: "up" | "down" | "unknown" | "paused";
  lastResponseTimeMs?: number | null;
  lastCheckedAt?: string | null;
}): Promise<void> {
  await db.insert(monitors).values({
    id: opts.id,
    clientId: opts.clientId,
    name: opts.name,
    url: "https://target.example.com/health",
    nextCheckAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(monitorState).values({
    monitorId: opts.id,
    status: opts.status ?? "unknown",
    lastResponseTimeMs: opts.lastResponseTimeMs ?? null,
    lastCheckedAt: opts.lastCheckedAt ?? null,
    updatedAt: NOW,
  });
}

async function seedCheck(opts: { id: string; monitorId: string; completedAt: string; healthy: boolean }): Promise<void> {
  await db.insert(checkResults).values({
    id: opts.id,
    monitorId: opts.monitorId,
    source: "scheduled",
    scheduledFor: opts.completedAt,
    startedAt: opts.completedAt,
    completedAt: opts.completedAt,
    isHealthy: opts.healthy ? 1 : 0,
    maintenanceExcluded: 0,
    affectsState: 1,
    reasonCode: opts.healthy ? "ok" : "http_status_5xx",
    createdAt: opts.completedAt,
  });
}

async function seedHourly(opts: {
  monitorId: string;
  hourStart: string;
  avgResponseTimeMs: number | null;
  eligibleChecks: number;
}): Promise<void> {
  await db.insert(hourlyRollups).values({
    monitorId: opts.monitorId,
    hourStart: opts.hourStart,
    eligibleChecks: opts.eligibleChecks,
    upChecks: opts.eligibleChecks,
    downChecks: 0,
    avgResponseTimeMs: opts.avgResponseTimeMs,
  });
}

beforeAll(async () => {
  testDb = await createTestDb();
  db = getDb(testDb.env);
  await db.insert(clients).values([
    { id: "cli_a", name: "Alpha Lda", slug: "alpha", active: 1, createdAt: NOW, updatedAt: NOW },
    { id: "cli_b", name: "Beta Lda", slug: "beta", active: 1, createdAt: NOW, updatedAt: NOW },
  ]);

  // Up monitor with 24h checks: 3 healthy + 1 down → 75.00, plus last-check meta.
  await seedMonitor({ id: "mon_up", clientId: "cli_a", name: "Alpha Site", status: "up", lastResponseTimeMs: 120, lastCheckedAt: NOW });
  for (let i = 0; i < 4; i += 1) {
    await seedCheck({
      id: `chk_up_${i}`,
      monitorId: "mon_up",
      completedAt: new Date(Date.parse(NOW) - (i + 1) * 3_600_000).toISOString(),
      healthy: i < 3,
    });
  }
  // An out-of-window check (25h old) must not count toward 24h uptime.
  await seedCheck({ id: "chk_up_old", monitorId: "mon_up", completedAt: new Date(Date.parse(NOW) - 25 * 3_600_000).toISOString(), healthy: true });
  // An ineligible manual check must not count either.
  await db.insert(checkResults).values({
    id: "chk_up_manual",
    monitorId: "mon_up",
    source: "manual",
    scheduledFor: NOW,
    startedAt: NOW,
    completedAt: NOW,
    isHealthy: 0,
    affectsState: 0,
    reasonCode: "http_status_5xx",
    createdAt: NOW,
  });

  // Second up monitor (same client) — exercises the grouped uptime aggregate.
  await seedMonitor({ id: "mon_up2", clientId: "cli_a", name: "Alpha API", status: "up", lastResponseTimeMs: 80, lastCheckedAt: NOW });
  await seedCheck({ id: "chk_up2_1", monitorId: "mon_up2", completedAt: new Date(Date.parse(NOW) - 2 * 3_600_000).toISOString(), healthy: true });

  // Down monitor with an OPEN incident (the Incident column links to it).
  await seedMonitor({ id: "mon_down", clientId: "cli_b", name: "Beta Portal", status: "down", lastResponseTimeMs: 210, lastCheckedAt: NOW });
  await db.insert(incidents).values({
    id: "inc_open_1",
    monitorId: "mon_down",
    status: "open",
    openedAt: new Date(Date.parse(NOW) - 2 * 3_600_000).toISOString(),
    firstFailureAt: new Date(Date.parse(NOW) - 2 * 3_600_000).toISOString(),
    createdAt: NOW,
    updatedAt: NOW,
  });

  // A recovered incident on the up monitor → recent recovery.
  await db.insert(incidents).values({
    id: "inc_resolved_1",
    monitorId: "mon_up",
    status: "resolved",
    openedAt: new Date(Date.parse(NOW) - 6 * 3_600_000).toISOString(),
    firstFailureAt: new Date(Date.parse(NOW) - 6 * 3_600_000).toISOString(),
    resolvedAt: new Date(Date.parse(NOW) - 5 * 3_600_000).toISOString(),
    outageDurationMs: 3_600_000,
    resolutionReason: "recovered",
    createdAt: NOW,
    updatedAt: NOW,
  });

  // Never-checked monitor → unknown status + uptime no_data.
  await seedMonitor({ id: "mon_new", clientId: "cli_b", name: "Beta New", status: "unknown" });
  // Paused monitor.
  await seedMonitor({ id: "mon_paused", clientId: "cli_a", name: "Alpha Paused", status: "paused" });
  // Archived monitor must not appear anywhere.
  await db.insert(monitors).values({
    id: "mon_archived",
    clientId: "cli_a",
    name: "Alpha Archived",
    url: "https://target.example.com/old",
    nextCheckAt: NOW,
    archivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });

  // Maintenance: monitor-scoped window covering mon_down at NOW. startsAt
  // EXACTLY at NOW pins the [start, end) boundary law shared with the checker.
  await db.insert(maintenanceWindows).values({
    id: "mnt_mon",
    title: "Beta Portal works",
    scopeType: "monitor",
    scopeId: "mon_down",
    startsAt: NOW,
    endsAt: new Date(Date.parse(NOW) + 3_600_000).toISOString(),
    createdAt: NOW,
    updatedAt: NOW,
  });
  // A CANCELLED window that would cover mon_up — must be ignored.
  await db.insert(maintenanceWindows).values({
    id: "mnt_cancelled",
    title: "Cancelled works",
    scopeType: "monitor",
    scopeId: "mon_up",
    startsAt: new Date(Date.parse(NOW) - 3_600_000).toISOString(),
    endsAt: new Date(Date.parse(NOW) + 3_600_000).toISOString(),
    cancelledAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });

  // Trend rollups: 2 in-window hours + an out-of-window + a NULL-signal hour.
  // 10:00: mon_up avg 100 (×2 eligible), mon_up2 avg 200 (×1) → weighted (100×2+200×1)/3 = 133.33 → 133.
  await seedHourly({ monitorId: "mon_up", hourStart: "2026-09-06T10:00:00.000Z", avgResponseTimeMs: 100, eligibleChecks: 2 });
  await seedHourly({ monitorId: "mon_up2", hourStart: "2026-09-06T10:00:00.000Z", avgResponseTimeMs: 200, eligibleChecks: 1 });
  // 11:00: only mon_up, avg 150 → 150.
  await seedHourly({ monitorId: "mon_up", hourStart: "2026-09-06T11:00:00.000Z", avgResponseTimeMs: 150, eligibleChecks: 3 });
  // Outside the 24h window — excluded.
  await seedHourly({ monitorId: "mon_up", hourStart: "2026-09-04T11:00:00.000Z", avgResponseTimeMs: 999, eligibleChecks: 5 });
  // An hour where every avg is NULL — no signal, dropped from the trend.
  await seedHourly({ monitorId: "mon_up", hourStart: "2026-09-06T09:00:00.000Z", avgResponseTimeMs: null, eligibleChecks: 4 });
  // Future-dated rollup (clock skew) — must not leak into the trend.
  await seedHourly({ monitorId: "mon_up", hourStart: "2026-09-07T00:00:00.000Z", avgResponseTimeMs: 777, eligibleChecks: 9 });
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("getDashboard aggregates (PRD §27.3, injected clock)", () => {
  it("returns every §27.3 aggregate in one response for mixed fixture states", async () => {
    const data = await getDashboard(testDb.env, { now: NOW });

    expect(data.counts).toEqual({
      totalActive: 5, // archived monitor excluded
      up: 2,
      down: 1,
      unknown: 1,
      paused: 1,
      inMaintenance: 1, // mon_down only; the cancelled window is ignored
      openIncidents: 1,
    });

    expect(data.monitors).toHaveLength(5);
    const names = data.monitors.map((m) => m.name);
    expect(names).toContain("Alpha Site");
    expect(names).not.toContain("Alpha Archived");

    const monUp = data.monitors.find((m) => m.id === "mon_up");
    expect(monUp).toMatchObject({
      clientName: "Alpha Lda",
      status: "up",
      inMaintenance: false,
      lastResponseTimeMs: 120,
      lastCheckedAt: NOW,
      openIncidentId: null,
    });
    // 3 healthy / 4 in-window eligible → 75.00; manual + 25h-old rows excluded.
    expect(monUp?.uptime24h).toEqual({ status: "ok", percentage: 75, eligibleChecks: 4 });

    const monDown = data.monitors.find((m) => m.id === "mon_down");
    expect(monDown).toMatchObject({ status: "down", inMaintenance: true, openIncidentId: "inc_open_1" });

    const monNew = data.monitors.find((m) => m.id === "mon_new");
    expect(monNew?.uptime24h).toEqual({ status: "no_data", percentage: null, eligibleChecks: 0 });

    expect(data.heartbeat).toEqual({
      status: "ok", // bootstrap grace: heartbeats never written yet
      checks: { d1: true, scheduler: true, consumer: true },
    });
  });

  it("builds the response-time trend from rollups, eligible-weighted per hour", async () => {
    const data = await getDashboard(testDb.env, { now: NOW });
    expect(data.trend).toEqual([
      { hourStart: "2026-09-06T10:00:00.000Z", avgResponseTimeMs: 133 }, // (100×2 + 200×1) / 3
      { hourStart: "2026-09-06T11:00:00.000Z", avgResponseTimeMs: 150 },
    ]);
  });

  it("lists recent recoveries with monitor names, newest first", async () => {
    const data = await getDashboard(testDb.env, { now: NOW });
    expect(data.recentRecoveries).toEqual([
      {
        id: "inc_resolved_1",
        monitorId: "mon_up",
        monitorName: "Alpha Site",
        resolvedAt: new Date(Date.parse(NOW) - 5 * 3_600_000).toISOString(),
        outageDurationMs: 3_600_000,
      },
    ]);
  });

  it("renders an empty dashboard (no monitors) without errors", async () => {
    const { mf, env } = await createTestDb();
    try {
      const data = await getDashboard(env, { now: NOW });
      expect(data.counts).toEqual({
        totalActive: 0,
        up: 0,
        down: 0,
        unknown: 0,
        paused: 0,
        inMaintenance: 0,
        openIncidents: 0,
      });
      expect(data.monitors).toEqual([]);
      expect(data.trend).toEqual([]);
      expect(data.recentRecoveries).toEqual([]);
    } finally {
      await disposeTestDb(mf);
    }
  });
});

describe("GET /api/dashboard route (fixtures relative to wall clock)", () => {
  it("serves the aggregate envelope through the real app", async () => {
    const { mf, env } = await createTestDb();
    try {
      const live = getDb(env);
      const nowMs = Date.now();
      const hourStart = new Date(Math.floor((nowMs - 3_600_000) / 3_600_000) * 3_600_000).toISOString();

      await live.insert(clients).values({ id: "cli_rt", name: "Route Co", slug: "route", active: 1, createdAt: NOW, updatedAt: NOW });
      await live.insert(monitors).values({
        id: "mon_rt",
        clientId: "cli_rt",
        name: "Route Monitor",
        url: "https://target.example.com/health",
        nextCheckAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await live.insert(monitorState).values({ monitorId: "mon_rt", status: "up", stateVersion: 1, updatedAt: NOW });
      await live.insert(checkResults).values({
        id: "chk_rt_1",
        monitorId: "mon_rt",
        source: "scheduled",
        scheduledFor: new Date(nowMs - 1_800_000).toISOString(),
        startedAt: new Date(nowMs - 1_800_000).toISOString(),
        completedAt: new Date(nowMs - 1_800_000).toISOString(),
        isHealthy: 1,
        affectsState: 1,
        reasonCode: "ok",
        createdAt: new Date(nowMs - 1_800_000).toISOString(),
      });
      await live.insert(hourlyRollups).values({
        monitorId: "mon_rt",
        hourStart,
        eligibleChecks: 2,
        upChecks: 2,
        downChecks: 0,
        avgResponseTimeMs: 90,
      });

      const { default: app } = await import("../../worker/app");
      const response = await app.request("/api/dashboard", { headers: { Origin: "http://localhost:5173" } }, env);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: {
          counts: { totalActive: number; up: number };
          monitors: Array<{ id: string; uptime24h: { percentage: number } }>;
          trend: unknown[];
        };
      };
      expect(body.data.counts.totalActive).toBe(1);
      expect(body.data.counts.up).toBe(1);
      expect(body.data.monitors[0]).toMatchObject({ id: "mon_rt", uptime24h: { percentage: 100 } });
      expect(body.data.trend).toHaveLength(1);
    } finally {
      await disposeTestDb(mf);
    }
  });
});
