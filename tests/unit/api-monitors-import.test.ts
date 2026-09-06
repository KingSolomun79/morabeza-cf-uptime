/**
 * Issue #27 — bulk import/export (PRD §25): mixed valid/invalid fixtures,
 * duplicate detection, sensitive-header rejection, size cap, audit event,
 * and the export → import round-trip. Against real D1 (miniflare).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeTestDb, createTestDb, LOCAL_ORIGIN, type TestD1 } from "../helpers/d1";
import app from "../../worker/app";
import { getDb } from "../../worker/lib/db";
import { auditEvents, monitors } from "../../db/schema";
import { eq as eqColumn } from "drizzle-orm";
import { MAX_IMPORT_ROWS } from "../../worker/services/monitor-import";
import type { Env } from "../../worker/env";

let testDb: TestD1;
let env: Env;

async function request(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Origin: LOCAL_ORIGIN, "X-Dev-Access-Email": "ops@morabeza.cv", ...(init.headers ?? {}) },
  }, { ...testDb.env, ...overrides } as Env);
}

interface RowResult {
  index: number;
  status: "created" | "duplicate" | "failed";
  name: string | null;
  monitorId?: string;
  existingMonitorId?: string;
  errors?: Array<{ path: string; message: string }>;
}

interface ImportResponse {
  status: number;
  body: {
    data?: { summary: { total: number; created: number; duplicates: number; failed: number }; results: RowResult[] };
    error?: { category: string; details: Array<{ path: string; message: string }> | null };
  };
}

async function importRows(rows: unknown[], overrides: Partial<Env> = {}): Promise<ImportResponse> {
  const response = await request("/api/monitors/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rows),
  }, overrides);
  return { status: response.status, body: (await response.json()) as ImportResponse["body"] };
}

beforeAll(async () => {
  testDb = await createTestDb();
  env = testDb.env;
  // Seeded client "cli_morabeza" comes from the 0001 migration (name
  // "Morabeza") — the §25.1 canonical example references it by name.
}, 30000);

afterAll(async () => {
  await disposeTestDb(testDb.mf);
});

describe("POST /api/monitors/import (#27)", () => {
  it("creates valid rows, reports invalid ones with index + reason, and commits valid rows", async () => {
    const { status, body } = await importRows([
      { client: "Morabeza", name: "Homepage", url: "https://contabilistas.cv/", intervalSeconds: 300 },
      { client: "Morabeza", name: "", url: "https://invalid.example.com/" }, // empty name → fails
      { client: "Ghost Client", name: "Unknown Client Row", url: "https://unknown.example.com/" }, // unresolvable client
      { client: "morabeza", name: "API", url: "https://api.contabilistas.cv/health", method: "GET" }, // slug-ish name, case-insensitive
    ]);

    expect(status).toBe(201);
    expect(body.data!.summary).toEqual({ total: 4, created: 2, duplicates: 0, failed: 2 });

    const [okRow, badName, unknownClient, okRow2] = body.data!.results;
    expect(okRow.status).toBe("created");
    expect(okRow.monitorId).toBeTruthy();
    expect(badName.status).toBe("failed");
    expect(badName.errors?.some((detail) => detail.path === "name")).toBe(true);
    expect(unknownClient.status).toBe("failed");
    expect(unknownClient.errors?.[0]?.message).toMatch(/unknown client "Ghost Client"/);
    expect(okRow2.status).toBe("created");

    // Created rows exist and are scheduler-pickup-ready (next_check_at set).
    const db = getDb(env);
    const created = await db.select().from(monitors).where(eqColumn(monitors.id, okRow.monitorId!));
    expect(created).toHaveLength(1);
    expect(created[0]?.nextCheckAt).toBeTruthy();

    // One audit event for the import action.
    const audits = await db.select().from(auditEvents).where(eqColumn(auditEvents.action, "monitor.import"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.summary).toContain("created 2");
  });

  it("flags probable duplicates as SKIPPED, not duplicated (round-trip idempotency)", async () => {
    const row = { client: "Morabeza", name: "Homepage Copy", url: "https://contabilistas.cv/" };
    const first = await importRows([row]);
    expect(first.body.data!.results[0].status).toBe("duplicate");
    expect(first.body.data!.results[0].existingMonitorId).toBeTruthy();
    expect(first.body.data!.summary.duplicates).toBe(1);

    // The skip must not have created a second monitor row.
    const db = getDb(env);
    const all = await db.select().from(monitors).where(eqColumn(monitors.url, "https://contabilistas.cv/"));
    expect(all).toHaveLength(1);
  });

  it("rejects sensitive headers anywhere in the file (PRD §10.9)", async () => {
    const { body } = await importRows([
      {
        client: "Morabeza",
        name: "With Secret",
        url: "https://secret.example.com/",
        headers: { Authorization: "Bearer nope" },
      },
    ]);
    expect(body.data!.results[0].status).toBe("failed");
    expect(body.data!.results[0].errors?.[0]?.message).toMatch(/security-sensitive header "Authorization"/);
  });

  it("rejects malformed JSON, non-arrays, and empty files with the §38 validation envelope", async () => {
    const malformed = await request("/api/monitors/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as { error: { category: string } };
    expect(malformedBody.error.category).toBe("validation");

    const notArray = await importRows({ nope: true } as unknown as unknown[]);
    expect(notArray.status).toBe(400);

    const empty = await importRows([]);
    expect(empty.status).toBe(400);
    expect(empty.body.error?.details?.[0]?.message).toMatch(/at least one row/);
  });

  it("enforces the row-count size cap", async () => {
    const tooMany = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({
      client: "Morabeza",
      name: `Row ${i}`,
      url: `https://row-${i}.example.com/`,
    }));
    const { status, body } = await importRows(tooMany);
    expect(status).toBe(400);
    expect(body.error?.details?.[0]?.message).toMatch(/at most 500 rows/);
  });

  it("rejects unauthenticated imports like every /api route", async () => {
    const { status, body } = await importRows([{ client: "Morabeza", name: "x", url: "https://x.example.com/" }], {
      APP_ACCESS_MODE: "locked",
    });
    expect(status).toBe(401);
    expect(body.error?.category).toBe("authentication_required");
  });
});

describe("GET /api/monitors/export + round-trip (#27)", () => {
  it("exports the canonical shape with client names and no archived rows", async () => {
    const response = await request("/api/monitors/export");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{
        client: string;
        name: string;
        url: string;
        method: string;
        headers: Record<string, string> | null;
        intervalSeconds: number;
        expectedStatusCodes: number[];
        timeoutMs: number;
        failureThreshold: number;
        recoveryThreshold: number;
        cacheBust: boolean;
      }>;
    };

    expect(body.data.length).toBeGreaterThanOrEqual(2);
    const homepage = body.data.find((row) => row.name === "Homepage")!;
    expect(homepage.client).toBe("Morabeza");
    expect(homepage.url).toBe("https://contabilistas.cv/");
    expect(homepage.method).toBe("GET");
    expect(homepage.intervalSeconds).toBe(300);
    expect(homepage.expectedStatusCodes).toEqual([200]);
    expect(homepage.headers).toBeNull(); // fixture had no headers
  });

  it("round-trips: importing the export again flags everything as duplicates and creates nothing", async () => {
    const exportResponse = await request("/api/monitors/export");
    const { data: exported } = (await exportResponse.json()) as { data: unknown[] };

    const db = getDb(env);
    const before = await db.select({ id: monitors.id }).from(monitors);
    const { status, body } = await importRows(exported);

    expect(status).toBe(201);
    expect(body.data!.summary.duplicates).toBe(exported.length);
    expect(body.data!.summary.created).toBe(0);
    const after = await db.select({ id: monitors.id }).from(monitors);
    expect(after).toHaveLength(before.length);
  });
});
