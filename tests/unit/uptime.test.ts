/**
 * Issue #20 — uptime calculations + GET /api/monitors/:id/uptime
 * (PRD §24, §26, §36, §32.1).
 *
 * Service-level tests use a fixed clock (computeUptime takes windowEnd +
 * rawCheckDays directly); route-level tests exercise the envelopes through
 * the real Hono app. Real D1 via miniflare.
 *
 * Coverage map (issue ACs):
 * - §32.1 matrix: manual / maintenance-excluded / affects_state=0 excluded;
 *   paused (no rows) → no_data, never 100%;
 * - 24h/7d from raw; 30d/90d blended; var moves the strategy;
 * - straddling blend exact — switchover aligned to the hour, no double
 *   counting of the boundary hour;
 * - §32.1 rollup-vs-raw agreement on a deterministic fixture;
 * - percentage math exact (98/100 → 98; rounding at the edge only);
 * - unknown monitor → 404 envelope; invalid window → 400 envelope.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeTestDb, createTestDb, LOCAL_ORIGIN, type TestD1 } from "../helpers/d1";
import app from "../../worker/app";
import { getDb } from "../../worker/lib/db";
import { checkResults, clients, hourlyRollups, monitors } from "../../db/schema";
import { computeUptime, resolveRawRetentionDays } from "../../worker/services/uptime";
import type { Env } from "../../worker/env";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOW = "2026-09-06T00:07:00.000Z";
/** floor-to-hour of NOW − 7d — the blend switchover under the 7d default. */
const SWITCHOVER_7D = "2026-08-30T00:00:00.000Z";

let testDb: TestD1;
let db: ReturnType<typeof getDb>;

beforeAll(async () => {
  testDb = await createTestDb();
  db = getDb(testDb.env);
  await db.insert(clients).values({
    id: "cli_uptime",
    name: "Uptime",
    slug: "uptime",
    active: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const monitorIds = [
    "mon_u", "mon_empty", "mon_pct98", "mon_pct667", "mon_pct50", "mon_blend",
    "mon_straddle", "mon_agree", "mon_strategy", "mon_rt",
  ];
  for (const id of monitorIds) {
    await db.insert(monitors).values({
      id,
      clientId: "cli_uptime",
      name: `Monitor ${id}`,
      url: "https://target.example.com/health",
      nextCheckAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

// ---------------------------------------------------------------------------
// Seeding helpers

let seq = 0;

async function seedCheck(opts: {
  monitorId: string;
  completedAt: string;
  healthy?: boolean;
  source?: "scheduled" | "manual";
  maintenanceExcluded?: boolean;
  affectsState?: boolean;
}): Promise<void> {
  seq += 1;
  await db.insert(checkResults).values({
    id: `chk-${seq}`,
    monitorId: opts.monitorId,
    source: opts.source ?? "scheduled",
    scheduledFor: opts.completedAt,
    startedAt: opts.completedAt,
    completedAt: opts.completedAt,
    isHealthy: (opts.healthy ?? true) ? 1 : 0,
    maintenanceExcluded: (opts.maintenanceExcluded ?? false) ? 1 : 0,
    affectsState: (opts.affectsState ?? true) ? 1 : 0,
    reasonCode: (opts.healthy ?? true) ? "ok" : "http_status_5xx",
    createdAt: opts.completedAt,
  });
}

/** Bulk seed for percentage fixtures (chunks stay under D1's param limit). */
async function seedChecksBulk(monitorId: string, count: number, healthyCount: number, withinMs: number): Promise<void> {
  const values = Array.from({ length: count }, (_, i) => {
    const completedAt = new Date(Date.parse(NOW) - withinMs + i * 1000).toISOString();
    return {
      id: `chk-bulk-${monitorId}-${i}`,
      monitorId,
      source: "scheduled",
      scheduledFor: completedAt,
      startedAt: completedAt,
      completedAt,
      isHealthy: i < healthyCount ? 1 : 0,
      maintenanceExcluded: 0,
      affectsState: 1,
      reasonCode: i < healthyCount ? "ok" : "http_status_5xx",
      createdAt: completedAt,
    };
  });
  for (let i = 0; i < values.length; i += 6) {
    await db.insert(checkResults).values(values.slice(i, i + 6));
  }
}

async function seedHourly(monitorId: string, hourStart: string, eligible: number, up: number): Promise<void> {
  await db.insert(hourlyRollups).values({
    monitorId,
    hourStart,
    eligibleChecks: eligible,
    upChecks: up,
    downChecks: eligible - up,
  });
}

function uptime(monitorId: string, window: "24h" | "7d" | "30d" | "90d", rawCheckDays = 7) {
  return computeUptime(db, monitorId, window, { windowEnd: NOW, rawCheckDays });
}

// ---------------------------------------------------------------------------
// §26 eligibility + no_data

describe("uptime eligibility (PRD §26)", () => {
  it("counts only eligible scheduled checks; manual and maintenance rows never count", async () => {
    for (const at of ["2026-09-05T01:10:00.000Z", "2026-09-05T05:20:00.000Z", "2026-09-05T09:30:00.000Z", "2026-09-05T13:40:00.000Z"]) {
      await seedCheck({ monitorId: "mon_u", completedAt: at });
    }
    await seedCheck({ monitorId: "mon_u", completedAt: "2026-09-05T15:50:00.000Z", healthy: false });
    await seedCheck({ monitorId: "mon_u", completedAt: "2026-09-05T10:00:00.000Z", source: "manual", affectsState: false });
    await seedCheck({ monitorId: "mon_u", completedAt: "2026-09-05T11:00:00.000Z", maintenanceExcluded: true });
    await seedCheck({ monitorId: "mon_u", completedAt: "2026-09-05T12:00:00.000Z", affectsState: false });

    const result = await uptime("mon_u", "24h");
    expect(result).toEqual({
      monitorId: "mon_u",
      window: "24h",
      status: "ok",
      percentage: 80,
      eligibleChecks: 5,
      healthyChecks: 4,
      source: "raw",
    });
  });

  it("returns explicit no_data (never 100%) for paused/no-check monitors", async () => {
    const result = await uptime("mon_empty", "24h");
    expect(result).toEqual({
      monitorId: "mon_empty",
      window: "24h",
      status: "no_data",
      percentage: null,
      eligibleChecks: 0,
      healthyChecks: 0,
      source: "raw",
    });
  });

  it("windows filter by completed_at: out-of-window checks never count", async () => {
    await seedCheck({ monitorId: "mon_u", completedAt: "2026-09-05T02:00:00.000Z" }); // in 24h
    await seedCheck({ monitorId: "mon_u", completedAt: "2026-09-04T23:00:00.000Z" }); // in 7d, out of 24h
    await seedCheck({ monitorId: "mon_u", completedAt: "2026-08-31T00:00:00.000Z" }); // in 7d
    await seedCheck({ monitorId: "mon_u", completedAt: "2026-08-29T00:00:00.000Z" }); // outside 7d

    const d24 = await uptime("mon_u", "24h");
    expect(d24).toMatchObject({ eligibleChecks: 6, healthyChecks: 5, source: "raw" }); // + matrix fixture's 1 in-window
    const d7 = await uptime("mon_u", "7d");
    expect(d7).toMatchObject({ eligibleChecks: 8, healthyChecks: 7, source: "raw" }); // 8d-old check excluded
  });
});

// ---------------------------------------------------------------------------
// Percentage math

describe("uptime percentage math", () => {
  it("is exact for known fixtures: 98/100 → 98, 2/3 → 66.67, 1/2 → 50", async () => {
    await seedChecksBulk("mon_pct98", 100, 98, 3_600_000);
    await seedCheck({ monitorId: "mon_pct667", completedAt: "2026-09-05T01:00:00.000Z" });
    await seedCheck({ monitorId: "mon_pct667", completedAt: "2026-09-05T02:00:00.000Z" });
    await seedCheck({ monitorId: "mon_pct667", completedAt: "2026-09-05T03:00:00.000Z", healthy: false });
    await seedCheck({ monitorId: "mon_pct50", completedAt: "2026-09-05T01:00:00.000Z" });
    await seedCheck({ monitorId: "mon_pct50", completedAt: "2026-09-05T02:00:00.000Z", healthy: false });

    expect(await uptime("mon_pct98", "24h")).toMatchObject({ percentage: 98, eligibleChecks: 100, healthyChecks: 98 });
    expect(await uptime("mon_pct667", "24h")).toMatchObject({ percentage: 66.67, eligibleChecks: 3, healthyChecks: 2 });
    expect(await uptime("mon_pct50", "24h")).toMatchObject({ percentage: 50, eligibleChecks: 2, healthyChecks: 1 });
  });
});

// ---------------------------------------------------------------------------
// Source strategy: raw / blended across the retention switchover

describe("uptime source strategy (raw ↔ rollup blend)", () => {
  it("blends raw + rollups for a straddling 30d window with exact boundary alignment", async () => {
    // Raw side (>= switchover): 3 eligible checks, 2 healthy.
    for (const [at, healthy] of [
      ["2026-08-30T05:00:00.000Z", true],
      ["2026-09-01T05:00:00.000Z", true],
      ["2026-09-03T05:00:00.000Z", false],
    ] as const) {
      await seedCheck({ monitorId: "mon_blend", completedAt: at, healthy });
    }
    // Rollup side (< switchover, >= 30d window start 2026-08-07T00:07Z):
    // five hours × (eligible 2, up 1) + one 4/4 hour just below switchover.
    for (const hour of ["2026-08-10T10:00:00.000Z", "2026-08-15T10:00:00.000Z", "2026-08-20T10:00:00.000Z", "2026-08-25T10:00:00.000Z", "2026-08-27T10:00:00.000Z"]) {
      await seedHourly("mon_blend", hour, 2, 1);
    }
    await seedHourly("mon_blend", "2026-08-29T23:00:00.000Z", 4, 4);
    // The 30d window's first (partial) hour participates WHOLE: the window
    // starts at :07 but its hour row (00:00) is included.
    await seedHourly("mon_blend", "2026-08-07T00:00:00.000Z", 6, 6);
    // Boundary guards: must ALL be ignored.
    await seedHourly("mon_blend", SWITCHOVER_7D, 9999, 9999); // hour AT switchover → raw territory
    await seedHourly("mon_blend", "2026-08-06T23:00:00.000Z", 8888, 8888); // before the 30d window

    const result = await uptime("mon_blend", "30d");
    expect(result).toMatchObject({
      status: "ok",
      source: "blended",
      eligibleChecks: 3 + 10 + 4 + 6, // raw + rollup hours + 23:00 hour + first partial hour
      healthyChecks: 2 + 5 + 4 + 6,
      percentage: Math.round(((2 + 5 + 4 + 6) / (3 + 10 + 4 + 6)) * 100 * 100) / 100,
    });
    // The guards would blow these numbers up if the boundary leaked.
    expect(result.eligibleChecks).toBe(23);
  });

  it("never double-counts a check on either side of the switchover", async () => {
    // Exactly AT the switchover → raw territory only.
    await seedCheck({ monitorId: "mon_straddle", completedAt: SWITCHOVER_7D });
    // Just below → rollup territory; its raw row exists but must not count.
    await seedCheck({ monitorId: "mon_straddle", completedAt: "2026-08-29T23:59:59.999Z" });
    await seedHourly("mon_straddle", "2026-08-29T23:00:00.000Z", 1, 1);

    const result = await uptime("mon_straddle", "30d");
    expect(result).toMatchObject({
      source: "blended",
      eligibleChecks: 2, // 3 if the 23:59:59.999 check were double counted
      healthyChecks: 2,
      percentage: 100,
    });
  });

  it("derives the strategy from RAW_CHECK_RETENTION_DAYS (#19 coupling)", async () => {
    // §18 default 7d: a 30d window straddles → blended; the same window with
    // 90d raw retention sits fully inside raw → raw.
    await seedCheck({ monitorId: "mon_strategy", completedAt: "2026-09-01T00:00:00.000Z" });
    expect(await uptime("mon_strategy", "30d")).toMatchObject({ source: "blended" });
    expect(await uptime("mon_strategy", "30d", 90)).toMatchObject({ source: "raw", eligibleChecks: 1 });
  });

  it("resolves the var with §18 defaults and fails loud on garbage", async () => {
    expect(resolveRawRetentionDays(testDb.env)).toBe(7);
    expect(resolveRawRetentionDays({ ...testDb.env, RAW_CHECK_RETENTION_DAYS: "30" } as Env)).toBe(30);
    expect(() => resolveRawRetentionDays({ ...testDb.env, RAW_CHECK_RETENTION_DAYS: "7.5" } as Env)).toThrow(/RAW_CHECK_RETENTION_DAYS/);
  });
});

// ---------------------------------------------------------------------------
// §32.1 rollup vs raw agreement

describe("uptime agreement (PRD §32.1)", () => {
  it("blended rollup path agrees with the raw-only path on a deterministic fixture", async () => {
    // 40 checks spread deterministically across the 7d window and ALIGNED TO
    // WHOLE HOURS that sit strictly INSIDE the window — rollups aggregate
    // hour buckets, so exact ms-vs-hour agreement is only defined when no
    // check lands in a boundary hour (the window start :07 is mid-hour).
    // Rollup rows are derived mechanically from the SAME fixture.
    const stepMs = Math.floor((7 * DAY_MS - 2 * HOUR_MS) / 40);
    const checks = Array.from({ length: 40 }, (_, i) => {
      const hourAligned = Math.floor((Date.parse(NOW) - 7 * DAY_MS) / HOUR_MS) * HOUR_MS + HOUR_MS + i * stepMs;
      return { completedAt: new Date(hourAligned).toISOString(), healthy: i % 4 !== 0 };
    });
    for (const check of checks) {
      await seedCheck({ monitorId: "mon_agree", completedAt: check.completedAt, healthy: check.healthy });
    }
    // Rollups = the fixture grouped by hour (what #18 would have produced).
    const byHour = new Map<string, { eligible: number; up: number }>();
    for (const check of checks) {
      const hourStart = new Date(Math.floor(Date.parse(check.completedAt) / HOUR_MS) * HOUR_MS).toISOString();
      const entry = byHour.get(hourStart) ?? { eligible: 0, up: 0 };
      entry.eligible += 1;
      if (check.healthy) entry.up += 1;
      byHour.set(hourStart, entry);
    }
    for (const [hourStart, counts] of byHour) {
      await seedHourly("mon_agree", hourStart, counts.eligible, counts.up);
    }

    const blended = await uptime("mon_agree", "7d", 2); // switchover 2d back
    const rawOnly = await uptime("mon_agree", "7d", 90); // whole window in raw

    expect(blended.source).toBe("blended");
    expect(rawOnly.source).toBe("raw");
    expect(blended.eligibleChecks).toBe(rawOnly.eligibleChecks);
    expect(blended.healthyChecks).toBe(rawOnly.healthyChecks);
    expect(blended.percentage).toBe(rawOnly.percentage);
    // Meaningful fixture: both sides of the switchover hold checks.
    expect(blended.eligibleChecks).toBe(40);
  }, 30000); // 80 individual miniflare inserts + two uptime queries
});

// ---------------------------------------------------------------------------
// Route: GET /api/monitors/:id/uptime

describe("GET /api/monitors/:id/uptime (PRD §24)", () => {
  async function get(path: string): Promise<Response> {
    return app.request(path, { headers: { Origin: LOCAL_ORIGIN } }, testDb.env as Env);
  }

  it("returns the uptime envelope for a known monitor", async () => {
    await seedCheck({ monitorId: "mon_rt", completedAt: "2026-09-05T10:00:00.000Z" });

    const response = await get("/api/monitors/mon_rt/uptime?window=24h");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      monitorId: "mon_rt",
      window: "24h",
      status: "ok",
      percentage: 100,
      eligibleChecks: 1,
      healthyChecks: 1,
      source: "raw",
    });
  });

  it("defaults the window to 24h", async () => {
    const response = await get("/api/monitors/mon_rt/uptime");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { window: string } };
    expect(body.data.window).toBe("24h");
  });

  it("returns a 404 not_found envelope for an unknown monitor", async () => {
    const response = await get("/api/monitors/mon_missing/uptime?window=7d");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { category: string } };
    expect(body.error.category).toBe("not_found");
  });

  it("returns a 400 validation envelope for an invalid window", async () => {
    const response = await get("/api/monitors/mon_rt/uptime?window=48h");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { category: string; details: Array<{ path: string }> } };
    expect(body.error.category).toBe("validation");
    expect(body.error.details?.[0]?.path).toBe("window");
  });

  it("accepts the 90d window literal end-to-end", async () => {
    const response = await get("/api/monitors/mon_rt/uptime?window=90d");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { window: string; source: string } };
    expect(body.data.window).toBe("90d");
    expect(body.data.source).toBe("blended"); // 90d > 7d raw retention
  });
});
