/**
 * Bulk monitor import/export (issue #27; PRD §25).
 *
 * Canonical row shape (§25.1): clients are referenced by NAME (or slug),
 * not id — resolution is case-insensitive, per-row reported when unknown.
 *
 * Commit policy (documented per the issue's implementer choice): the
 * COMPLETE file is validated first; then valid unique rows are created and
 * probable duplicates (same client + url + method) are SKIPPED with a
 * pointer to the existing monitor — flagged, not duplicated — so
 * import(export(x)) is idempotent. Invalid rows never block valid ones;
 * every row reports its outcome with its file index.
 *
 * Size bound: MAX_IMPORT_ROWS caps one file; each row is bounded by the
 * shared §22 schema (the SAME Zod validator the single-create route uses —
 * one validator, two entry points). No mass immediate checks: rows get the
 * normal next_check_at and the scheduler picks them up (#12/#10).
 */
import { createMonitorSchema, findSensitiveHeader } from "../lib/monitor-schema";
import { ApiError } from "../lib/errors";
import { getDb } from "../lib/db";
import { clients, monitors } from "../../db/schema";
import { isNull } from "drizzle-orm";
import { createMonitor, findProbableDuplicate } from "../repositories/monitors";
import type { Env } from "../env";

export const MAX_IMPORT_ROWS = 500;

export type ImportRowStatus = "created" | "duplicate" | "failed";

export interface ImportRowResult {
  index: number;
  status: ImportRowStatus;
  name: string | null;
  monitorId?: string;
  existingMonitorId?: string;
  errors?: Array<{ path: string; message: string }>;
}

export interface ImportResult {
  summary: { total: number; created: number; duplicates: number; failed: number };
  results: ImportRowResult[];
}

/** §10.9 sanitizer for export: defensive — create/update already reject
 * sensitive names, but a backup must never carry one forward. */
export function sanitizeHeaders(headers: Record<string, string> | null): Record<string, string> | null {
  if (!headers) return null;
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!findSensitiveHeader({ [name]: value })) clean[name] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

/** Case-insensitive resolution by exact name or slug (§25.1 "client": "Morabeza"). */
export async function resolveClientRows(env: Env): Promise<Map<string, string>> {
  const db = getDb(env);
  const rows = await db.select({ id: clients.id, name: clients.name, slug: clients.slug }).from(clients);
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.name.toLowerCase(), row.id);
    map.set(row.slug.toLowerCase(), row.id);
  }
  return map;
}

async function loadExportRows(env: Env): Promise<Array<Record<string, unknown>>> {
  const db = getDb(env);
  const rows = await db
    .select({
      monitorId: monitors.id,
      clientId: monitors.clientId,
      name: monitors.name,
      url: monitors.url,
      method: monitors.method,
      headersJson: monitors.headersJson,
      bodyContains: monitors.bodyContains,
      bodyNotContains: monitors.bodyNotContains,
      maxResponseTimeMs: monitors.maxResponseTimeMs,
      intervalSeconds: monitors.intervalSeconds,
      timeoutMs: monitors.timeoutMs,
      failureThreshold: monitors.failureThreshold,
      recoveryThreshold: monitors.recoveryThreshold,
      cacheBust: monitors.cacheBust,
      expectedStatusCodesJson: monitors.expectedStatusCodesJson,
      tagsJson: monitors.tagsJson,
    })
    .from(monitors)
    .where(isNull(monitors.archivedAt))
    .orderBy(monitors.name);

  const clientNames = new Map<string, string>();
  const clientRows = await db.select({ id: clients.id, name: clients.name }).from(clients);
  for (const row of clientRows) clientNames.set(row.id, row.name);

  function parseJson<T>(value: string | null, fallback: T): T {
    if (value === null) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  return rows.map((row) => ({
    client: clientNames.get(row.clientId) ?? row.clientId,
    name: row.name,
    url: row.url,
    method: row.method,
    headers: sanitizeHeaders(parseJson<Record<string, string> | null>(row.headersJson, null)),
    intervalSeconds: row.intervalSeconds,
    expectedStatusCodes: parseJson<number[]>(row.expectedStatusCodesJson, [200]),
    bodyContains: row.bodyContains,
    bodyNotContains: row.bodyNotContains,
    maxResponseTimeMs: row.maxResponseTimeMs,
    timeoutMs: row.timeoutMs,
    failureThreshold: row.failureThreshold,
    recoveryThreshold: row.recoveryThreshold,
    cacheBust: row.cacheBust === 1,
    tags: parseJson<string[] | null>(row.tagsJson, null),
  }));
}

export async function exportMonitors(env: Env): Promise<Array<Record<string, unknown>>> {
  return loadExportRows(env);
}

function rowErrorsFromIssues(issues: Array<{ path: Array<string | number | symbol>; message: string }>): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "row",
    message: issue.message,
  }));
}

export async function importMonitors(env: Env, body: unknown): Promise<ImportResult> {
  if (!Array.isArray(body)) {
    throw ApiError.validation("import body must be a JSON array of monitor rows");
  }
  if (body.length === 0) {
    throw ApiError.validation("import body is empty", [{ path: "rows", message: "at least one row is required" }]);
  }
  if (body.length > MAX_IMPORT_ROWS) {
    throw ApiError.validation("import file exceeds the size cap", [
      { path: "rows", message: `at most ${MAX_IMPORT_ROWS} rows per import (got ${body.length})` },
    ]);
  }

  const clientMap = await resolveClientRows(env);

  // Pass 1 — validate EVERY row before touching the database (§25.1).
  const plan: Array<{
    index: number;
    name: string | null;
    status: "create" | "fail";
    clientId?: string;
    row?: Record<string, unknown>;
    errors?: Array<{ path: string; message: string }>;
  }> = [];

  for (let index = 0; index < body.length; index++) {
    const raw = body[index] as Record<string, unknown> | null;
    const name = typeof raw?.name === "string" ? raw.name : null;

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      plan.push({ index, name, status: "fail", errors: [{ path: "row", message: "row must be a JSON object" }] });
      continue;
    }

    const errors: Array<{ path: string; message: string }> = [];

    // Client resolution: name or slug, case-insensitive (§25.1 canonical shape).
    const clientKey = typeof raw.client === "string" ? raw.client.trim().toLowerCase() : "";
    const clientId = clientKey === "" ? undefined : clientMap.get(clientKey);
    if (!clientId) {
      errors.push({ path: "client", message: `unknown client "${String(raw.client ?? "")}" — create the client first` });
    }

    const headers = (raw.headers ?? null) as Record<string, string> | null;
    const sensitive = findSensitiveHeader(headers);
    if (sensitive) {
      errors.push({
        path: "headers",
        message: `security-sensitive header "${sensitive}" is rejected in V1 (PRD §10.9)`,
      });
    }

    let parsed: Record<string, unknown> | undefined;
    if (clientId) {
      const result = createMonitorSchema.safeParse({ ...raw, clientId });
      if (!result.success) {
        errors.push(...rowErrorsFromIssues(result.error.issues));
      } else {
        parsed = result.data as Record<string, unknown>;
      }
    }

    plan.push({ index, name, status: errors.length > 0 ? "fail" : "create", clientId, row: parsed, errors });
  }

  // Pass 2 — create the valid rows, skipping probable duplicates (flagged,
  // not duplicated, so import(export(x)) is idempotent).
  const results: ImportRowResult[] = [];
  let created = 0;
  let duplicates = 0;
  let failed = 0;

  for (const entry of plan) {
    if (entry.status === "fail") {
      failed += 1;
      results.push({ index: entry.index, status: "failed", name: entry.name, errors: entry.errors });
      continue;
    }
    const row = entry.row!;
    const duplicateId = await findProbableDuplicate(env, {
      clientId: entry.clientId!,
      url: row.url as string,
      method: row.method as string,
    });
    if (duplicateId) {
      duplicates += 1;
      results.push({
        index: entry.index,
        status: "duplicate",
        name: entry.name,
        existingMonitorId: duplicateId,
        errors: [{ path: "url", message: `probable duplicate of monitor ${duplicateId} (same client, url, and method)` }],
      });
      continue;
    }
    const createdMonitor = await createMonitor(env, row as Parameters<typeof createMonitor>[1]);
    created += 1;
    results.push({ index: entry.index, status: "created", name: entry.name, monitorId: createdMonitor.id });
  }

  return {
    summary: { total: body.length, created, duplicates, failed },
    results,
  };
}
