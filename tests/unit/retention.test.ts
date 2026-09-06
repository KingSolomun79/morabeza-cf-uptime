/**
 * Issue #19 — retention cleanup (PRD §18).
 *
 * Real D1 via miniflare. Service-level tests pin exact boundaries with an
 * injected `now`; handler-level tests exercise vars parsing and heartbeats
 * against real time (fixtures offset from Date.now(), gotcha 7).
 *
 * Coverage map (issue ACs):
 * - fixture data pruned exactly per configured windows; newer data untouched;
 * - incidents, maintenance windows, notification + audit events survive;
 * - re-delivery deletes nothing twice (second run = 0 rows everywhere);
 * - deletes run in bounded batches (batchSize override + >500 backlog);
 * - last_cleanup_at heartbeat + one structured summary log.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { disposeTestDb, createTestDb, type TestD1 } from "../helpers/d1";
import { getDb } from "../../worker/lib/db";
import {
  auditEvents,
  checkResults,
  clients,
  dailyRollups,
  deadLetterEvents,
  hourlyRollups,
  incidents,
  maintenanceWindows,
  monitors,
  notificationEvents,
  notificationTargets,
  schedulerRuns,
} from "../../db/schema";
import { runRetentionCleanup, RETENTION_BATCH_SIZE } from "../../worker/services/retention";
import { createRetentionCleanupHandler } from "../../worker/queue/handlers/retention-cleanup";
import { getSystemState } from "../../worker/repositories/system";

const DAY_MS = 86_400_000;
/** Fixed service-test clock (a 00:07 UTC run, mirroring the #10 dispatch). */
const NOW = "2026-09-06T00:07:00.000Z";

let testDb: TestD1;
let db: ReturnType<typeof getDb>;

beforeAll(async () => {
  testDb = await createTestDb();
  db = getDb(testDb.env);
  await db.insert(clients).values({
    id: "cli_retention",
    name: "Retention",
    slug: "retention",
    active: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(monitors).values({
    id: "mon_ret",
    clientId: "cli_retention",
    name: "Monitor ret",
    url: "https://target.example.com/health",
    nextCheckAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(notificationTargets).values({
    id: "tgt_ret",
    name: "Ops",
    email: "ops@example.com",
    enabled: 1,
    isDefault: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

// ---------------------------------------------------------------------------
// Seeding helpers

let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function daysBeforeNow(days: number, offsetMs = 0): string {
  return new Date(Date.parse(NOW) - days * DAY_MS + offsetMs).toISOString();
}

async function seedCheck(opts: {
  id?: string;
  completedAt: string;
  source?: "scheduled" | "manual";
  maintenanceExcluded?: boolean;
}): Promise<string> {
  const id = opts.id ?? uid("chk");
  await db.insert(checkResults).values({
    id,
    monitorId: "mon_ret",
    source: opts.source ?? "scheduled",
    scheduledFor: opts.completedAt,
    startedAt: opts.completedAt,
    completedAt: opts.completedAt,
    isHealthy: 1,
    maintenanceExcluded: opts.maintenanceExcluded ? 1 : 0,
    affectsState: 1,
    reasonCode: "ok",
    createdAt: opts.completedAt,
  });
  return id;
}

async function seedSchedulerRun(id: string, createdAt: string): Promise<void> {
  await db.insert(schedulerRuns).values({
    id,
    scheduledAt: createdAt,
    dueMonitorCount: 0,
    enqueuedCount: 0,
    durationMs: 1,
    createdAt,
  });
}

async function seedHourly(monitorId: string, hourStart: string): Promise<void> {
  await db.insert(hourlyRollups).values({
    monitorId,
    hourStart,
    eligibleChecks: 1,
    upChecks: 1,
    downChecks: 0,
  });
}

async function seedDaily(monitorId: string, dayStart: string): Promise<void> {
  await db.insert(dailyRollups).values({
    monitorId,
    dayStart,
    eligibleChecks: 1,
    upChecks: 1,
    downChecks: 0,
  });
}

async function seedDeadLetter(id: string, opts: { receivedAt: string; resolvedAt?: string }): Promise<void> {
  await db.insert(deadLetterEvents).values({
    id,
    originalJobId: `job:${id}`,
    messageType: "monitor.check",
    failureReason: "boom",
    receivedAt: opts.receivedAt,
    resolvedAt: opts.resolvedAt ?? null,
  });
}

async function rowExists(table: "check_results" | "scheduler_runs" | "dead_letter_events", id: string): Promise<boolean> {
  const tables = { check_results: checkResults, scheduler_runs: schedulerRuns, dead_letter_events: deadLetterEvents } as const;
  const [row] = await db.select({ id: tables[table].id }).from(tables[table]).where(eq(tables[table].id, id));
  return row !== undefined;
}

/** Seeds one ancient (400d) row of every never-touch table. */
async function seedProtectedRows(): Promise<void> {
  const ancient = daysBeforeNow(400);
  await db.insert(incidents).values({
    id: uid("inc"),
    monitorId: "mon_ret",
    status: "open",
    openedAt: ancient,
    firstFailureAt: ancient,
    createdAt: ancient,
    updatedAt: ancient,
  });
  await db.insert(maintenanceWindows).values({
    id: uid("mnt"),
    title: "Ancient window",
    scopeType: "global",
    scopeId: null,
    startsAt: ancient,
    endsAt: new Date(Date.parse(ancient) + 3_600_000).toISOString(),
    createdAt: ancient,
    updatedAt: ancient,
  });
  await db.insert(notificationEvents).values({
    id: uid("evt"),
    dedupeKey: `dedupe:${uid("dk")}`,
    monitorId: "mon_ret",
    incidentId: null,
    targetId: "tgt_ret",
    type: "down",
    status: "sent",
    createdAt: ancient,
    sentAt: ancient,
    updatedAt: ancient,
  });
  await db.insert(auditEvents).values({
    id: uid("aud"),
    actorEmail: "ops@example.com",
    action: "monitor.update",
    entityType: "monitor",
    entityId: "mon_ret",
    createdAt: ancient,
  });
}

async function countTable(table: typeof incidents | typeof maintenanceWindows | typeof notificationEvents | typeof auditEvents): Promise<number> {
  const rows = await db.select({ one: table.id }).from(table);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Service: boundary pruning

describe("runRetentionCleanup boundaries (PRD §18)", () => {
  it("deletes strictly-expired rows per window and keeps just-inside rows + protected tables", async () => {
    // Boundaries derived with the documented formula (now − N days).
    const rawCutoff = daysBeforeNow(7);
    const runsCutoff = daysBeforeNow(7);
    const hourlyCutoff = daysBeforeNow(90);
    const dailyCutoff = daysBeforeNow(730);

    // check_results: ±1s around the raw cutoff, plus old manual and
    // maintenance-excluded rows (pruned wholesale by age, per the issue's
    // §18 reading).
    const chkIn = await seedCheck({ id: "chk-in", completedAt: new Date(Date.parse(rawCutoff) + 1_000).toISOString() });
    const chkOut = await seedCheck({ id: "chk-out", completedAt: new Date(Date.parse(rawCutoff) - 1_000).toISOString() });
    const chkManual = await seedCheck({ id: "chk-manual", completedAt: daysBeforeNow(8), source: "manual" });
    const chkMaint = await seedCheck({ id: "chk-maint", completedAt: daysBeforeNow(8), maintenanceExcluded: true });
    await seedSchedulerRun("sr-in", new Date(Date.parse(runsCutoff) + 1_000).toISOString());
    await seedSchedulerRun("sr-out", new Date(Date.parse(runsCutoff) - 1_000).toISOString());
    await seedHourly("mon_ret", new Date(Date.parse(hourlyCutoff) + 1_000).toISOString());
    await seedHourly("mon_ret", new Date(Date.parse(hourlyCutoff) - 1_000).toISOString());
    await seedDaily("mon_ret", new Date(Date.parse(dailyCutoff) + 1_000).toISOString());
    await seedDaily("mon_ret", new Date(Date.parse(dailyCutoff) - 1_000).toISOString());
    await seedDeadLetter("dl-old-resolved", { receivedAt: daysBeforeNow(100), resolvedAt: daysBeforeNow(31) });
    await seedDeadLetter("dl-new-resolved", { receivedAt: daysBeforeNow(100), resolvedAt: daysBeforeNow(29) });
    await seedDeadLetter("dl-unresolved-ancient", { receivedAt: daysBeforeNow(100) });

    const protectedBefore = {
      incidents: await countTable(incidents),
      maintenance: await countTable(maintenanceWindows),
      notifications: await countTable(notificationEvents),
      audit: await countTable(auditEvents),
    };
    await seedProtectedRows();
    const protectedWithNew = {
      incidents: protectedBefore.incidents + 1,
      maintenance: protectedBefore.maintenance + 1,
      notifications: protectedBefore.notifications + 1,
      audit: protectedBefore.audit + 1,
    };

    const summary = await runRetentionCleanup(
      db,
      { rawCheckDays: 7, hourlyDays: 90, dailyDays: 730 },
      { now: NOW },
    );

    expect(summary.deleted).toEqual({
      checkResults: 3, // out-of-window scheduled + old manual + old maintenance
      schedulerRuns: 1,
      hourlyRollups: 1,
      dailyRollups: 1,
      resolvedDeadLetters: 1, // resolved >30d; unresolved rows never match
    });
    expect(summary.cutoffs.checkResults).toBe(rawCutoff);

    expect(await rowExists("check_results", chkIn)).toBe(true);
    expect(await rowExists("check_results", chkOut)).toBe(false);
    expect(await rowExists("check_results", chkManual)).toBe(false);
    expect(await rowExists("check_results", chkMaint)).toBe(false);
    expect(await rowExists("scheduler_runs", "sr-in")).toBe(true);
    expect(await rowExists("scheduler_runs", "sr-out")).toBe(false);
    expect(await rowExists("dead_letter_events", "dl-new-resolved")).toBe(true);
    expect(await rowExists("dead_letter_events", "dl-unresolved-ancient")).toBe(true);
    expect(await rowExists("dead_letter_events", "dl-old-resolved")).toBe(false);

    // §18 retain-forever tables: untouched (seeded ancient rows all present).
    expect(await countTable(incidents)).toBe(protectedWithNew.incidents);
    expect(await countTable(maintenanceWindows)).toBe(protectedWithNew.maintenance);
    expect(await countTable(notificationEvents)).toBe(protectedWithNew.notifications);
    expect(await countTable(auditEvents)).toBe(protectedWithNew.audit);
  });

  it("is idempotent: a re-delivery for the same day deletes nothing twice", async () => {
    await seedCheck({ id: "chk-idem", completedAt: daysBeforeNow(8) });

    const first = await runRetentionCleanup(db, { rawCheckDays: 7, hourlyDays: 90, dailyDays: 730 }, { now: NOW });
    expect(first.deleted.checkResults).toBeGreaterThanOrEqual(1); // includes chk-idem

    // Redelivery (same jobId semantics): boundary already clean → all zeros.
    const second = await runRetentionCleanup(db, { rawCheckDays: 7, hourlyDays: 90, dailyDays: 730 }, { now: NOW });
    expect(second.deleted).toEqual({
      checkResults: 0,
      schedulerRuns: 0,
      hourlyRollups: 0,
      dailyRollups: 0,
      resolvedDeadLetters: 0,
    });
    expect(await rowExists("check_results", "chk-idem")).toBe(false);
  });

  it("loops bounded batches: more expired rows than one batch are still fully cleared", async () => {
    // Small override batch (5) with 12 expired rows → 3 loop iterations.
    for (let i = 0; i < 12; i += 1) {
      await seedCheck({ completedAt: daysBeforeNow(8) });
    }
    await seedCheck({ id: "chk-keep", completedAt: daysBeforeNow(1) });

    const summary = await runRetentionCleanup(
      db,
      { rawCheckDays: 7, hourlyDays: 90, dailyDays: 730 },
      { now: NOW, batchSize: 5 },
    );
    expect(summary.deleted.checkResults).toBe(12);
    expect(await rowExists("check_results", "chk-keep")).toBe(true);
  });

  it("clears a >500-row backlog with the default batch size (real loop, not one statement)", async () => {
    // D1 caps bound parameters per statement, so seed in small chunks
    // (6 rows × 16 columns = 96 params, under D1's 100-param limit).
    const values = Array.from({ length: 600 }, (_, i) => ({
      id: `chk-backlog-${i}`,
      monitorId: "mon_ret",
      source: "scheduled",
      scheduledFor: daysBeforeNow(8),
      startedAt: daysBeforeNow(8),
      completedAt: daysBeforeNow(8),
      isHealthy: 1,
      maintenanceExcluded: 0,
      affectsState: 1,
      reasonCode: "ok",
      createdAt: daysBeforeNow(8),
    }));
    for (let i = 0; i < values.length; i += 6) {
      await db.insert(checkResults).values(values.slice(i, i + 6));
    }

    const summary = await runRetentionCleanup(db, { rawCheckDays: 7, hourlyDays: 90, dailyDays: 730 }, { now: NOW });
    expect(summary.deleted.checkResults).toBe(600);
    expect(summary.deleted.checkResults).toBeGreaterThan(RETENTION_BATCH_SIZE); // ≥2 batches happened
  }, 60000); // 100 chunked miniflare inserts + the batched delete loop
});

// ---------------------------------------------------------------------------
// Handler: vars parsing, heartbeats, summary log

async function invokeCleanup(envOverrides: Record<string, string>, jobId: string) {
  const env = { ...testDb.env, ...envOverrides };
  await createRetentionCleanupHandler()({}, { env, jobId, messageId: `msg_${jobId}` });
}

describe("retention.cleanup handler (issue #19)", () => {
  it("applies vars overrides and prunes at the configured windows", async () => {
    const old = new Date(Date.now() - 2 * DAY_MS).toISOString();
    const fresh = new Date(Date.now() - 12 * 3_600_000).toISOString();
    await seedCheck({ id: "chk-var-old", completedAt: old });
    await seedCheck({ id: "chk-var-fresh", completedAt: fresh });
    await seedHourly("mon_ret", old);
    await seedDaily("mon_ret", old);

    await invokeCleanup(
      { RAW_CHECK_RETENTION_DAYS: "1", HOURLY_RETENTION_DAYS: "1", DAILY_RETENTION_DAYS: "1" },
      "retention.cleanup:vars",
    );

    expect(await rowExists("check_results", "chk-var-old")).toBe(false);
    expect(await rowExists("check_results", "chk-var-fresh")).toBe(true);
    const hourly = await db.select().from(hourlyRollups);
    const daily = await db.select().from(dailyRollups);
    expect(hourly.find((r) => r.hourStart === old)).toBeUndefined();
    expect(daily.find((r) => r.dayStart === old)).toBeUndefined();
  });

  it("fails loud on a present-but-invalid var (retry → DLQ, never silently misprune)", async () => {
    await expect(
      invokeCleanup({ RAW_CHECK_RETENTION_DAYS: "seven" }, "retention.cleanup:bad-var"),
    ).rejects.toThrow(/RAW_CHECK_RETENTION_DAYS/);
  });

  it("writes last_cleanup_at and one structured summary log on success", async () => {
    const before = Date.now();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await invokeCleanup({}, "retention.cleanup:heartbeat");

      const state = await getSystemState(testDb.env);
      expect(state?.lastCleanupAt).not.toBeNull();
      expect(new Date(state?.lastCleanupAt as string).getTime()).toBeGreaterThanOrEqual(before - 60_000);

      const cleanupLogs = logSpy.mock.calls
        .map((call) => JSON.parse(call[0] as string) as { event?: string; deletedCheckResults?: number })
        .filter((entry) => entry.event === "retention.cleanup_completed");
      expect(cleanupLogs).toHaveLength(1); // ONE summary log per run (PRD §28)
    } finally {
      logSpy.mockRestore();
    }
  });
});
