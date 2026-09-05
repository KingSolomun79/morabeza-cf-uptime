/**
 * Issue #3 — D1 schema roundtrip tests.
 *
 * Applies the committed migration SQL (db/migrations/*.sql) to an in-memory
 * SQLite database and verifies the full §17 data model: seed row, defaults,
 * per-table roundtrips, and the one-open-incident-per-monitor partial unique
 * index (PRD §17.5) plus notification dedupe-key uniqueness (PRD §17.9).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema";

// Vitest serves these through the Vite pipeline — no node:fs needed.
const migrationFiles = import.meta.glob("../../db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const NOW = "2026-09-05T12:00:00.000Z";

let client: Client;
let db: LibSQLDatabase<typeof schema>;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  const paths = Object.keys(migrationFiles).sort();
  // 0000_init_schema.sql + 0001_seed_and_guards.sql must both exist.
  expect(paths.length).toBe(2);

  for (const path of paths) {
    await client.executeMultiple(migrationFiles[path]);
  }

  db = drizzle(client, { schema });
});

async function seedBase(): Promise<void> {
  // Tests share one in-memory database; make seeding idempotent.
  await db
    .insert(schema.clients)
    .values({
      id: "cli_t",
      name: "Test Client",
      slug: "test-client",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .onConflictDoNothing();
  await db
    .insert(schema.monitors)
    .values({
      id: "mon_t",
      clientId: "cli_t",
      name: "Test Monitor",
      url: "https://example.com/",
      nextCheckAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .onConflictDoNothing();
}

describe("migrations + seed (PRD §33)", () => {
  it("applied all migrations and seeded the Morabeza client only", async () => {
    const rows = await db.select().from(schema.clients);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "cli_morabeza",
      name: "Morabeza",
      slug: "morabeza",
      active: 1,
    });
    expect(rows[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("seeded no production monitors (PRD §33)", async () => {
    const rows = await db.select().from(schema.monitors);

    expect(rows).toHaveLength(0);
  });
});

describe("monitor defaults (PRD §10.3–§10.5, §17.2)", () => {
  it("applies spec defaults on insert", async () => {
    await seedBase();

    const [monitor] = await db
      .select()
      .from(schema.monitors)
      .where(eq(schema.monitors.id, "mon_t"));

    expect(monitor).toMatchObject({
      method: "GET",
      expectedStatusCodesJson: "[200]",
      intervalSeconds: 300,
      timeoutMs: 10000,
      failureThreshold: 3,
      recoveryThreshold: 2,
      cacheBust: 0,
      enabled: 1,
    });
  });
});

describe("state + check history roundtrips", () => {
  it("roundtrips monitor_state (§17.3)", async () => {
    await seedBase();
    await db.insert(schema.monitorState).values({
      monitorId: "mon_t",
      status: "up",
      consecutiveSuccesses: 2,
      lastStatusCode: 200,
      lastResponseTimeMs: 87,
      lastReasonCode: "ok",
      lastEvaluatedScheduledFor: NOW,
      stateVersion: 1,
      updatedAt: NOW,
    });

    const [row] = await db
      .select()
      .from(schema.monitorState)
      .where(eq(schema.monitorState.monitorId, "mon_t"));

    expect(row).toMatchObject({
      status: "up",
      consecutiveSuccesses: 2,
      stateVersion: 1,
      openIncidentId: null,
    });
  });

  it("roundtrips check_results (§17.4)", async () => {
    await seedBase();
    await db.insert(schema.checkResults).values({
      id: "mon_t:2026-09-05T12:31:00Z",
      monitorId: "mon_t",
      source: "scheduled",
      scheduledFor: "2026-09-05T12:31:00Z",
      startedAt: NOW,
      completedAt: NOW,
      isHealthy: 1,
      affectsState: 1,
      statusCode: 200,
      responseTimeMs: 123,
      finalUrl: "https://example.com/",
      reasonCode: "ok",
      createdAt: NOW,
    });

    const [row] = await db
      .select()
      .from(schema.checkResults)
      .where(eq(schema.checkResults.id, "mon_t:2026-09-05T12:31:00Z"));

    expect(row).toMatchObject({
      monitorId: "mon_t",
      source: "scheduled",
      isHealthy: 1,
      maintenanceExcluded: 0,
      reasonCode: "ok",
    });
  });

  it("roundtrips maintenance_windows (§17.6)", async () => {
    await db.insert(schema.maintenanceWindows).values({
      id: "mw_t",
      title: "Deploy window",
      scopeType: "global",
      startsAt: NOW,
      endsAt: "2026-09-05T13:00:00.000Z",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const [row] = await db
      .select()
      .from(schema.maintenanceWindows)
      .where(eq(schema.maintenanceWindows.id, "mw_t"));

    expect(row).toMatchObject({ scopeType: "global", scopeId: null, cancelledAt: null });
  });
});

describe("incidents: one open per monitor (PRD §17.5, §37.2)", () => {
  it("allows one open incident, rejects a second, allows it after resolution", async () => {
    await seedBase();

    const openIncident = {
      id: "inc_t1",
      monitorId: "mon_t",
      status: "open",
      openedAt: NOW,
      firstFailureAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };

    await db.insert(schema.incidents).values(openIncident);

    // Second open incident for the same monitor must be rejected by the
    // partial unique index.
    await expect(
      db.insert(schema.incidents).values({
        ...openIncident,
        id: "inc_t2",
      }),
    ).rejects.toThrow();

    // A different monitor may have its own open incident.
    await db.insert(schema.monitors).values({
      id: "mon_u",
      clientId: "cli_t",
      name: "Other Monitor",
      url: "https://other.example.com/",
      nextCheckAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(schema.incidents).values({
      id: "inc_u1",
      monitorId: "mon_u",
      status: "open",
      openedAt: NOW,
      firstFailureAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    // Resolve the first; a later incident for the same monitor may open.
    await db
      .update(schema.incidents)
      .set({
        status: "resolved",
        resolvedAt: NOW,
        outageDurationMs: 60000,
        resolutionReason: "recovered",
        updatedAt: NOW,
      })
      .where(eq(schema.incidents.id, "inc_t1"));

    await db.insert(schema.incidents).values({
      id: "inc_t3",
      monitorId: "mon_t",
      status: "open",
      openedAt: NOW,
      firstFailureAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const monitorIncidents = await db
      .select()
      .from(schema.incidents)
      .where(eq(schema.incidents.monitorId, "mon_t"));
    expect(monitorIncidents).toHaveLength(2);
  });
});

describe("notifications roundtrips (§17.7–§17.9)", () => {
  it("roundtrips targets, monitor mappings, and dedupe-key uniqueness", async () => {
    await seedBase();

    await db.insert(schema.notificationTargets).values({
      id: "tgt_t",
      name: "Ops",
      email: "ops@morabeza.digital",
      isDefault: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Duplicate email must be rejected.
    await expect(
      db.insert(schema.notificationTargets).values({
        id: "tgt_t2",
        name: "Ops copy",
        email: "ops@morabeza.digital",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow();

    await db
      .insert(schema.monitorNotificationTargets)
      .values({ monitorId: "mon_t", targetId: "tgt_t" });
    // Composite PK prevents duplicate mappings.
    await expect(
      db
        .insert(schema.monitorNotificationTargets)
        .values({ monitorId: "mon_t", targetId: "tgt_t" }),
    ).rejects.toThrow();

    await db.insert(schema.notificationEvents).values({
      id: "evt_t1",
      dedupeKey: "inc_t1:down:tgt_t",
      monitorId: "mon_t",
      incidentId: "inc_t1",
      targetId: "tgt_t",
      type: "down",
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Same dedupe key (duplicate Queue delivery) must be rejected.
    await expect(
      db.insert(schema.notificationEvents).values({
        id: "evt_t2",
        dedupeKey: "inc_t1:down:tgt_t",
        monitorId: "mon_t",
        incidentId: "inc_t1",
        targetId: "tgt_t",
        type: "down",
        status: "pending",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow();
  });
});

describe("aggregates + system tables roundtrips (§17.10–§17.15)", () => {
  it("roundtrips hourly and daily rollups", async () => {
    await seedBase();

    await db.insert(schema.hourlyRollups).values({
      monitorId: "mon_t",
      hourStart: "2026-09-05T12:00:00.000Z",
      eligibleChecks: 12,
      upChecks: 11,
      downChecks: 1,
      avgResponseTimeMs: 182.5,
      minResponseTimeMs: 90,
      maxResponseTimeMs: 400,
    });
    await db.insert(schema.dailyRollups).values({
      monitorId: "mon_t",
      dayStart: "2026-09-05T00:00:00.000Z",
      eligibleChecks: 288,
      upChecks: 287,
      downChecks: 1,
      incidentCount: 1,
      downtimeMs: 120000,
    });

    const [hourly] = await db
      .select()
      .from(schema.hourlyRollups)
      .where(eq(schema.hourlyRollups.monitorId, "mon_t"));
    const [daily] = await db
      .select()
      .from(schema.dailyRollups)
      .where(eq(schema.dailyRollups.monitorId, "mon_t"));

    expect(hourly).toMatchObject({ eligibleChecks: 12, upChecks: 11 });
    expect(daily).toMatchObject({ incidentCount: 1, downtimeMs: 120000 });
  });

  it("roundtrips scheduler_runs, system_state, audit_events, dead_letter_events", async () => {
    await db.insert(schema.schedulerRuns).values({
      id: "sr_t",
      scheduledAt: NOW,
      dueMonitorCount: 3,
      enqueuedCount: 3,
      durationMs: 42,
      createdAt: NOW,
    });
    await db.insert(schema.systemState).values({
      id: "system",
      lastSchedulerAt: NOW,
      lastQueueConsumerAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(schema.auditEvents).values({
      id: "aud_t",
      actorEmail: "owner@morabeza.digital",
      action: "client.create",
      entityType: "client",
      entityId: "cli_t",
      createdAt: NOW,
    });
    await db.insert(schema.deadLetterEvents).values({
      id: "dlq_t",
      originalJobId: "job_t",
      messageType: "monitor.check",
      failureReason: "exhausted retries",
      receivedAt: NOW,
    });

    const [run] = await db
      .select()
      .from(schema.schedulerRuns)
      .where(eq(schema.schedulerRuns.id, "sr_t"));
    const [system] = await db
      .select()
      .from(schema.systemState)
      .where(eq(schema.systemState.id, "system"));
    const [audit] = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.id, "aud_t"));
    const [dead] = await db
      .select()
      .from(schema.deadLetterEvents)
      .where(eq(schema.deadLetterEvents.id, "dlq_t"));

    expect(run).toMatchObject({ dueMonitorCount: 3, failedBatchCount: 0 });
    expect(system.lastSchedulerAt).toBe(NOW);
    expect(audit.action).toBe("client.create");
    expect(dead.messageType).toBe("monitor.check");
  });
});
