/**
 * Issue #18 — hourly/daily rollups (PRD §17.10–§17.11, §26, §18, §32.1).
 *
 * Deterministic fixtures: known check_results across hours/days → exact
 * rollup rows; §32.1 (rollup and raw periods agree) is the exact-row
 * assertion. Real D1 via miniflare; handlers invoked directly (the
 * batch-isolation test exercises the consumer path).
 *
 * Coverage map (issue ACs):
 * - deterministic fixture → exact hourly/daily counts + min/avg/max;
 * - manual and maintenance-excluded checks never appear;
 * - same job twice → identical rows (no double counting);
 * - gotcha-8 race: rollup.daily BEFORE the previous day's last hourly →
 *   daily still correct (proves computation from raw check_results);
 * - outage fixture → incident_count/downtime_ms correct;
 * - heartbeats update; a rollup failure never blocks monitor checks.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { disposeTestDb, createTestDb, type TestD1 } from "../helpers/d1";
import { getDb } from "../../worker/lib/db";
import { checkResults, clients, dailyRollups, hourlyRollups, incidents, monitors } from "../../db/schema";
import { createDailyRollupHandler, createHourlyRollupHandler } from "../../worker/queue/handlers/rollups";
import { createQueueConsumer, type BatchLike, type MessageLike } from "../../worker/queue/consumer";
import { QUEUE_NAMES } from "../../worker/queue/schemas";
import { getSystemState } from "../../worker/repositories/system";

const DAY_START = "2026-09-04T00:00:00.000Z";
const DAY_END = "2026-09-05T00:00:00.000Z";
const HOUR_10 = "2026-09-04T10:00:00.000Z";
const HOUR_23 = "2026-09-04T23:00:00.000Z";
const CLIENT_ID = "cli_rollups";

let testDb: TestD1;
let db: ReturnType<typeof getDb>;

beforeAll(async () => {
  testDb = await createTestDb();
  db = getDb(testDb.env);
  // FKs are enforced in both directions (gotcha 7): checks and incidents
  // need their monitor, monitors need their client.
  await db.insert(clients).values({
    id: CLIENT_ID,
    name: "Rollups",
    slug: "rollups",
    active: 1,
    createdAt: DAY_START,
    updatedAt: DAY_START,
  });
  for (const id of ["mon_a", "mon_b", "mon_c", "mon_d", "mon_iso"]) {
    await seedMonitor(id);
  }
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

// ---------------------------------------------------------------------------
// Seeding + invocation helpers

async function seedMonitor(id: string): Promise<void> {
  await db
    .insert(monitors)
    .values({
      id,
      clientId: CLIENT_ID,
      name: `Monitor ${id}`,
      url: "https://target.example.com/health",
      nextCheckAt: DAY_END,
      createdAt: DAY_START,
      updatedAt: DAY_START,
    })
    .onConflictDoNothing();
}

async function seedCheck(opts: {
  id: string;
  monitorId: string;
  completedAt: string;
  healthy?: boolean;
  source?: "scheduled" | "manual";
  maintenanceExcluded?: boolean;
  affectsState?: boolean;
  responseTimeMs?: number | null;
}): Promise<void> {
  await db.insert(checkResults).values({
    id: opts.id,
    monitorId: opts.monitorId,
    source: opts.source ?? "scheduled",
    scheduledFor: opts.completedAt,
    startedAt: opts.completedAt,
    completedAt: opts.completedAt,
    isHealthy: (opts.healthy ?? true) ? 1 : 0,
    maintenanceExcluded: (opts.maintenanceExcluded ?? false) ? 1 : 0,
    affectsState: (opts.affectsState ?? true) ? 1 : 0,
    responseTimeMs: opts.responseTimeMs ?? null,
    reasonCode: (opts.healthy ?? true) ? "ok" : "http_status_5xx",
    createdAt: opts.completedAt,
  });
}

async function seedIncident(opts: {
  id: string;
  monitorId: string;
  openedAt: string;
  resolvedAt?: string | null;
}): Promise<void> {
  await db.insert(incidents).values({
    id: opts.id,
    monitorId: opts.monitorId,
    status: opts.resolvedAt ? "resolved" : "open",
    openedAt: opts.openedAt,
    firstFailureAt: opts.openedAt,
    resolvedAt: opts.resolvedAt ?? null,
    createdAt: opts.openedAt,
    updatedAt: opts.resolvedAt ?? opts.openedAt,
  });
}

async function runHourly(hourStart: string): Promise<void> {
  await createHourlyRollupHandler()(
    { hourStart },
    { env: testDb.env, jobId: `rollup.hourly:${hourStart}`, messageId: `msg_${hourStart}` },
  );
}

async function runDaily(dayStart: string): Promise<void> {
  await createDailyRollupHandler()(
    { dayStart },
    { env: testDb.env, jobId: `rollup.daily:${dayStart}`, messageId: `msg_${dayStart}` },
  );
}

async function hourlyRowFor(monitorId: string, hourStart: string) {
  const [row] = await db
    .select()
    .from(hourlyRollups)
    .where(and(eq(hourlyRollups.monitorId, monitorId), eq(hourlyRollups.hourStart, hourStart)));
  return row ?? null;
}

async function dailyRowFor(monitorId: string, dayStart: string) {
  const [row] = await db
    .select()
    .from(dailyRollups)
    .where(and(eq(dailyRollups.monitorId, monitorId), eq(dailyRollups.dayStart, dayStart)));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Hourly rollups

describe("rollup.hourly (PRD §17.10, §26)", () => {
  it("aggregates a deterministic fixture into exact counts and response times (§32.1 rollup = raw)", async () => {
    // Window [10:00, 11:00): 4 eligible checks — 3 up (100/151/200ms),
    // 1 down (NULL response). Boundary checks on both edges belong to the
    // NEIGHBORING hour; a manual check inside the window is excluded.
    await seedCheck({ id: "h10-edge-prev", monitorId: "mon_a", completedAt: "2026-09-04T09:59:59.999Z", responseTimeMs: 50 });
    await seedCheck({ id: "h10-start", monitorId: "mon_a", completedAt: "2026-09-04T10:00:00.000Z", responseTimeMs: 100 });
    await seedCheck({ id: "h10-mid", monitorId: "mon_a", completedAt: "2026-09-04T10:15:00.000Z", responseTimeMs: 151 });
    await seedCheck({ id: "h10-down", monitorId: "mon_a", completedAt: "2026-09-04T10:25:00.000Z", healthy: false, responseTimeMs: null });
    await seedCheck({ id: "h10-late", monitorId: "mon_a", completedAt: "2026-09-04T10:59:59.999Z", responseTimeMs: 200 });
    await seedCheck({ id: "h10-edge-next", monitorId: "mon_a", completedAt: "2026-09-04T11:00:00.000Z", responseTimeMs: 300 });
    await seedCheck({
      id: "h10-manual",
      monitorId: "mon_a",
      completedAt: "2026-09-04T10:30:00.000Z",
      source: "manual",
      affectsState: false,
      responseTimeMs: 1,
    });

    await runHourly(HOUR_10);

    const row = await hourlyRowFor("mon_a", HOUR_10);
    expect(row).toEqual({
      monitorId: "mon_a",
      hourStart: HOUR_10,
      eligibleChecks: 4,
      upChecks: 3,
      downChecks: 1,
      avgResponseTimeMs: expect.closeTo(150.3333, 3), // REAL, unrounded
      minResponseTimeMs: 100,
      maxResponseTimeMs: 200,
    });
  });

  it("never counts manual, maintenance-excluded, or affects_state=0 checks (PRD §26)", async () => {
    await seedCheck({ id: "h12-maint", monitorId: "mon_a", completedAt: "2026-09-04T12:10:00.000Z", maintenanceExcluded: true, responseTimeMs: 10 });
    await seedCheck({ id: "h12-noaffect", monitorId: "mon_a", completedAt: "2026-09-04T12:20:00.000Z", affectsState: false, responseTimeMs: 20 });
    // Only ONE eligible check lands in this window.
    await seedCheck({ id: "h12-eligible", monitorId: "mon_a", completedAt: "2026-09-04T12:30:00.000Z", responseTimeMs: 30 });

    await runHourly("2026-09-04T12:00:00.000Z");

    const row = await hourlyRowFor("mon_a", "2026-09-04T12:00:00.000Z");
    expect(row).toEqual({
      monitorId: "mon_a",
      hourStart: "2026-09-04T12:00:00.000Z",
      eligibleChecks: 1,
      upChecks: 1,
      downChecks: 0,
      avgResponseTimeMs: 30,
      minResponseTimeMs: 30,
      maxResponseTimeMs: 30,
    });
  });

  it("produces one row per monitor with eligible checks", async () => {
    await seedCheck({ id: "h13-a", monitorId: "mon_a", completedAt: "2026-09-04T13:01:00.000Z", responseTimeMs: 40 });
    await seedCheck({ id: "h13-b", monitorId: "mon_b", completedAt: "2026-09-04T13:02:00.000Z", healthy: false });

    await runHourly("2026-09-04T13:00:00.000Z");

    expect(await hourlyRowFor("mon_a", "2026-09-04T13:00:00.000Z")).toMatchObject({ eligibleChecks: 1, upChecks: 1 });
    expect(await hourlyRowFor("mon_b", "2026-09-04T13:00:00.000Z")).toMatchObject({ eligibleChecks: 1, upChecks: 0, downChecks: 1 });
  });

  it("re-running the same slot overwrites (no double counting), and folds in late raw rows", async () => {
    await seedCheck({ id: "h14-r1", monitorId: "mon_a", completedAt: "2026-09-04T14:01:00.000Z", responseTimeMs: 100 });
    await runHourly("2026-09-04T14:00:00.000Z");
    const first = await hourlyRowFor("mon_a", "2026-09-04T14:00:00.000Z");
    expect(first).toMatchObject({ eligibleChecks: 1, upChecks: 1 });

    // Re-delivery: identical job → identical row.
    await runHourly("2026-09-04T14:00:00.000Z");
    expect(await hourlyRowFor("mon_a", "2026-09-04T14:00:00.000Z")).toEqual(first);

    // A check inserted AFTER the first run is folded in by the recompute —
    // the upsert (not claim-once) is what makes late raw rows count.
    await seedCheck({ id: "h14-r2", monitorId: "mon_a", completedAt: "2026-09-04T14:02:00.000Z", healthy: false, responseTimeMs: 250 });
    await runHourly("2026-09-04T14:00:00.000Z");
    expect(await hourlyRowFor("mon_a", "2026-09-04T14:00:00.000Z")).toMatchObject({
      eligibleChecks: 2,
      upChecks: 1,
      downChecks: 1,
      minResponseTimeMs: 100,
      maxResponseTimeMs: 250,
    });
  });

  it("writes no row for a window with zero eligible checks, but still succeeds", async () => {
    await runHourly("2026-09-03T10:00:00.000Z"); // empty hour, empty day

    expect(await hourlyRowFor("mon_a", "2026-09-03T10:00:00.000Z")).toBeNull();
    const state = await getSystemState(testDb.env);
    expect(state?.lastHourlyRollupAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Daily rollups + incidents

describe("rollup.daily (PRD §17.11, §18)", () => {
  it("computes the full day from RAW checks even when run before the day's last hourly (gotcha-8 race)", async () => {
    // Fixture for mon_a across 2026-09-04 (hour-10/12/13/14 rows above plus:)
    await seedCheck({ id: "d00-a", monitorId: "mon_a", completedAt: "2026-09-04T00:10:00.000Z", responseTimeMs: 120 });
    await seedCheck({ id: "d08-a", monitorId: "mon_a", completedAt: "2026-09-04T08:05:00.000Z", healthy: false, responseTimeMs: null });
    await seedCheck({ id: "d08-b", monitorId: "mon_a", completedAt: "2026-09-04T08:15:00.000Z", responseTimeMs: 140 });
    await seedCheck({ id: "d23-a", monitorId: "mon_a", completedAt: "2026-09-04T23:50:00.000Z", responseTimeMs: 160 });
    await seedCheck({ id: "d23-b", monitorId: "mon_a", completedAt: "2026-09-04T23:59:59.999Z", responseTimeMs: 180 });
    // Boundary: belongs to the NEXT day, must not leak into this one.
    await seedCheck({ id: "d24-a", monitorId: "mon_a", completedAt: DAY_END, responseTimeMs: 999 });

    // THE RACE: daily runs before any hourly of the 23:xx window.
    await runDaily(DAY_START);

    // Eligible (whole DAY window — note the hour-10 boundary checks belong
    // here): 09:59:59.999, 10:00, 10:15, 10:25(down), 10:59:59.999,
    // 11:00:00.000, 12:30, 13:01, 14:01, 14:02(down), 00:10, 08:05(down),
    // 08:15, 23:50, 23:59:59.999 → 15 (the Sep-5 00:00 check is excluded)
    // Up: 12, Down: 3. Response times (non-NULL): 50,100,151,200,300,30,40,
    // 100,250,120,140,160,180 → avg 1821/13, min 30, max 300.
    const row = await dailyRowFor("mon_a", DAY_START);
    expect(row).toMatchObject({
      eligibleChecks: 15,
      upChecks: 12,
      downChecks: 3,
      minResponseTimeMs: 30,
      maxResponseTimeMs: 300,
    });
    expect(row?.avgResponseTimeMs).toBeCloseTo(
      (50 + 100 + 151 + 200 + 300 + 30 + 40 + 100 + 250 + 120 + 140 + 160 + 180) / 13,
      6,
    );

    // Now the lagging hourly lands — its own row is correct AND the daily
    // row is untouched (daily never sums hourly rows).
    await runHourly(HOUR_23);
    expect(await hourlyRowFor("mon_a", HOUR_23)).toMatchObject({ eligibleChecks: 2, upChecks: 2, minResponseTimeMs: 160, maxResponseTimeMs: 180 });
    expect(await dailyRowFor("mon_a", DAY_START)).toEqual(row);
  });

  it("counts incidents opened in the window and clips downtime overlaps deterministically", async () => {
    // mon_b: two incidents opened IN the window.
    //  inc_b1 08:00→08:30 resolved  → count 1, downtime 1_800_000
    //  inc_b2 23:50 still open      → count 1, downtime clipped to day end: 600_000
    // mon_c: carry-over incident (opened 23:00 the day BEFORE, resolved 01:00)
    //  → count 0, downtime 3_600_000 (the [00:00, 01:00) slice only)
    // mon_d: incident opened AFTER the window → zero effect on this day.
    await seedCheck({ id: "db-1", monitorId: "mon_b", completedAt: "2026-09-04T08:10:00.000Z", responseTimeMs: 90 });
    await seedCheck({ id: "db-2", monitorId: "mon_b", completedAt: "2026-09-04T23:55:00.000Z", healthy: false, responseTimeMs: null });
    await seedCheck({ id: "dc-1", monitorId: "mon_c", completedAt: "2026-09-04T00:30:00.000Z", responseTimeMs: 80 });
    await seedCheck({ id: "dc-2", monitorId: "mon_c", completedAt: "2026-09-04T01:30:00.000Z", responseTimeMs: 85 });
    await seedCheck({ id: "dd-1", monitorId: "mon_d", completedAt: "2026-09-04T12:00:00.000Z", responseTimeMs: 70 });
    await seedIncident({ id: "inc_b1", monitorId: "mon_b", openedAt: "2026-09-04T08:00:00.000Z", resolvedAt: "2026-09-04T08:30:00.000Z" });
    await seedIncident({ id: "inc_b2", monitorId: "mon_b", openedAt: "2026-09-04T23:50:00.000Z" });
    await seedIncident({ id: "inc_c1", monitorId: "mon_c", openedAt: "2026-09-03T23:00:00.000Z", resolvedAt: "2026-09-04T01:00:00.000Z" });
    await seedIncident({ id: "inc_d1", monitorId: "mon_d", openedAt: "2026-09-05T00:30:00.000Z" });

    await runDaily(DAY_START);
    await runDaily(DAY_START); // recompute — must be byte-identical (clipping never uses "now")

    expect(await dailyRowFor("mon_b", DAY_START)).toMatchObject({
      // 3 eligible: 08:10 up, 23:55 down, plus the 13:02 down check seeded by
      // the per-monitor hourly test above (shared D1 across this file).
      eligibleChecks: 3,
      upChecks: 1,
      downChecks: 2,
      incidentCount: 2,
      downtimeMs: 1_800_000 + 600_000,
    });
    expect(await dailyRowFor("mon_c", DAY_START)).toMatchObject({
      incidentCount: 0, // opened before the window: downtime without count
      downtimeMs: 3_600_000,
    });
    expect(await dailyRowFor("mon_d", DAY_START)).toMatchObject({
      incidentCount: 0,
      downtimeMs: 0,
    });

    // An incident-only monitor (zero eligible checks — e.g. paused mid-day)
    // gets NO daily row: absence is what lets #20 report no_data instead of
    // a zero-check day.
    await seedMonitor("mon_e");
    await seedIncident({ id: "inc_e1", monitorId: "mon_e", openedAt: "2026-09-04T10:00:00.000Z" });
    await runDaily(DAY_START);
    expect(await dailyRowFor("mon_e", DAY_START)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Heartbeats + failure isolation

describe("rollup heartbeats and isolation (PRD §18, §37.8)", () => {
  it("touches last_hourly_rollup_at / last_daily_rollup_at on success", async () => {
    const before = Date.now();
    await runHourly("2026-09-04T15:00:00.000Z");
    await runDaily("2026-09-03T00:00:00.000Z");

    const state = await getSystemState(testDb.env);
    expect(state?.lastHourlyRollupAt).not.toBeNull();
    expect(state?.lastDailyRollupAt).not.toBeNull();
    expect(new Date(state?.lastHourlyRollupAt as string).getTime()).toBeGreaterThanOrEqual(before - 60_000);
    expect(new Date(state?.lastDailyRollupAt as string).getTime()).toBeGreaterThanOrEqual(before - 60_000);
  });

  it("a failing rollup never blocks a monitor.check in the same batch (§37.8)", async () => {
    await seedCheck({ id: "iso-anchor", monitorId: "mon_iso", completedAt: "2026-09-04T16:00:00.000Z", responseTimeMs: 10 });

    const brokenRollup: MessageLike = {
      id: "msg_broken_rollup",
      body: {
        v: 1,
        type: "rollup.hourly",
        jobId: `rollup.hourly:broken-${Date.now()}`,
        payload: { hourStart: "not-a-timestamp" }, // handler throws → retry
      },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const check: MessageLike = {
      id: "msg_iso_check",
      body: {
        v: 1,
        type: "monitor.check",
        jobId: `mon_iso:2026-09-05T12:00:00.000Z-iso`,
        payload: {
          monitorId: "mon_iso",
          checkId: `mon_iso:2026-09-05T12:00:00.000Z-iso`,
          scheduledFor: "2026-09-05T12:00:00.000Z",
          source: "scheduled",
          affectsState: true,
        },
      },
      ack: vi.fn(),
      retry: vi.fn(),
    };

    const fetchMock = vi.fn(async () => new Response("fine", { status: 200 }));
    const consumer = createQueueConsumer({
      checkerDeps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });
    const heartbeatBefore = (await getSystemState(testDb.env))?.lastHourlyRollupAt ?? null;
    await consumer({ queue: QUEUE_NAMES.checks, messages: [brokenRollup, check] } as BatchLike, testDb.env);

    expect(brokenRollup.retry).toHaveBeenCalledTimes(1); // → DLQ after max_retries
    expect(check.ack).toHaveBeenCalledTimes(1); // scheduling work proceeded
    expect(check.retry).not.toHaveBeenCalled();
    // Heartbeats are success-only: a failed rollup must not touch it.
    expect((await getSystemState(testDb.env))?.lastHourlyRollupAt).toBe(heartbeatBefore);

    const [result] = await db
      .select()
      .from(checkResults)
      .where(eq(checkResults.id, "mon_iso:2026-09-05T12:00:00.000Z-iso"));
    expect(result?.isHealthy).toBe(1);
  });
});
