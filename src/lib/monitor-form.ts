/**
 * Monitor create/edit form logic (issue #23; PRD §10, §22).
 *
 * Single source of truth for validation: the SAME Zod schemas the API uses
 * (worker/lib/monitor-schema.ts) run client-side so operators get instant
 * field-level errors, and the server remains authoritative. This module is
 * pure (no DOM) so the §22 matrix is unit-testable in the node environment.
 */
import {
  createMonitorSchema,
  findConfigConflicts,
  findSensitiveHeader,
  INTERVAL_CHOICES,
} from "../../worker/lib/monitor-schema";
import type { MonitorDto } from "../types/monitor";

export { INTERVAL_CHOICES };

/** PRD §10.1: POST monitors may execute more than once — the form must warn. */
export const POST_METHOD_WARNING =
  "POST monitors may be executed more than once: queue redelivery and network retries can re-send the request. Use POST only for purpose-built idempotent health endpoints.";

/** One header row in the custom-headers editor (PRD §10.9). */
export interface HeaderRow {
  name: string;
  value: string;
}

/**
 * The form's raw state — every field is a string exactly as typed, so React
 * inputs stay controlled and validation happens in one place on submit.
 */
export interface MonitorFormValues {
  clientId: string;
  name: string;
  url: string;
  method: string;
  intervalSeconds: string;
  expectedStatusCodes: string;
  bodyContains: string;
  bodyNotContains: string;
  maxResponseTimeMs: string;
  timeoutMs: string;
  failureThreshold: string;
  recoveryThreshold: string;
  cacheBust: boolean;
  headers: HeaderRow[];
  requestBody: string;
  tags: string;
}

export function emptyMonitorFormValues(): MonitorFormValues {
  return {
    clientId: "",
    name: "",
    url: "",
    method: "GET",
    intervalSeconds: "300",
    expectedStatusCodes: "200",
    bodyContains: "",
    bodyNotContains: "",
    maxResponseTimeMs: "",
    timeoutMs: "10000",
    failureThreshold: "3",
    recoveryThreshold: "2",
    cacheBust: false,
    headers: [],
    requestBody: "",
    tags: "",
  };
}

/**
 * Prefills the form from an existing monitor — used by Edit and by Duplicate
 * (which renames to "(copy)" and leaves identity/state behind; the create
 * path re-validates everything and the server re-runs duplicate detection).
 */
export function monitorToFormValues(monitor: MonitorDto, mode: "edit" | "duplicate"): MonitorFormValues {
  return {
    clientId: monitor.clientId,
    name: mode === "duplicate" ? `${monitor.name} (copy)` : monitor.name,
    url: monitor.url,
    method: monitor.method,
    intervalSeconds: String(monitor.intervalSeconds),
    expectedStatusCodes: monitor.expectedStatusCodes.join(", "),
    bodyContains: monitor.bodyContains ?? "",
    bodyNotContains: monitor.bodyNotContains ?? "",
    maxResponseTimeMs: monitor.maxResponseTimeMs === null ? "" : String(monitor.maxResponseTimeMs),
    timeoutMs: String(monitor.timeoutMs),
    failureThreshold: String(monitor.failureThreshold),
    recoveryThreshold: String(monitor.recoveryThreshold),
    cacheBust: monitor.cacheBust,
    headers: Object.entries(monitor.headers ?? {}).map(([name, value]) => ({ name, value })),
    requestBody: monitor.requestBody ?? "",
    tags: (monitor.tags ?? []).join(", "),
  };
}

/**
 * Typed shape handed to validation: strings parsed to numbers/arrays, empty
 * optional fields as explicit nulls (a full-config edit clears them).
 */
export interface MonitorConfigInput {
  clientId: string;
  name: string;
  url: string;
  method: string;
  intervalSeconds: number;
  expectedStatusCodes: number[];
  bodyContains: string | null;
  bodyNotContains: string | null;
  maxResponseTimeMs: number | null;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  cacheBust: boolean;
  headers: Record<string, string> | null;
  requestBody: string | null;
  tags: string[] | null;
}

function parseNumber(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text.trim());
}

/** "200, 301" → [200, 301]; garbage tokens become NaN for zod to reject. */
function parseStatusCodes(text: string): number[] {
  return text
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => Number(token));
}

function parseTags(text: string): string[] | null {
  const tags = text
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return tags.length > 0 ? tags : null;
}

function parseHeaders(rows: HeaderRow[]): Record<string, string> | null {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    if (row.name.trim() === "" && row.value.trim() === "") continue;
    headers[row.name.trim()] = row.value;
  }
  return Object.keys(headers).length > 0 ? headers : null;
}

export function formValuesToConfigInput(values: MonitorFormValues): MonitorConfigInput {
  return {
    clientId: values.clientId,
    name: values.name,
    url: values.url,
    method: values.method,
    intervalSeconds: parseNumber(values.intervalSeconds),
    expectedStatusCodes: parseStatusCodes(values.expectedStatusCodes),
    bodyContains: values.bodyContains.trim() === "" ? null : values.bodyContains.trim(),
    bodyNotContains: values.bodyNotContains.trim() === "" ? null : values.bodyNotContains.trim(),
    maxResponseTimeMs: values.maxResponseTimeMs.trim() === "" ? null : parseNumber(values.maxResponseTimeMs),
    timeoutMs: parseNumber(values.timeoutMs),
    failureThreshold: parseNumber(values.failureThreshold),
    recoveryThreshold: parseNumber(values.recoveryThreshold),
    cacheBust: values.cacheBust,
    headers: parseHeaders(values.headers),
    requestBody: values.requestBody.trim() === "" ? null : values.requestBody,
    tags: parseTags(values.tags),
  };
}

export type MonitorFormValidation =
  | { ok: true; input: MonitorConfigInput }
  | { ok: false; errors: Record<string, string> };

/**
 * Runs the shared API schema plus the two semantic checks (sensitive header
 * names PRD §10.9, request-body/method conflict) and flattens everything to
 * one message per form field. The same checks run server-side — this is a
 * fast pre-flight, never the authority.
 */
export function validateMonitorConfig(input: MonitorConfigInput): MonitorFormValidation {
  const errors: Record<string, string> = {};

  const sensitive = findSensitiveHeader(input.headers);
  if (sensitive) {
    errors.headers = `security-sensitive header "${sensitive}" is rejected in V1 (PRD §10.9)`;
  }
  const conflict = findConfigConflicts({ method: input.method, requestBody: input.requestBody });
  if (conflict) {
    errors.requestBody = conflict;
  }

  const result = createMonitorSchema.safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = typeof issue.path[0] === "string" ? issue.path[0] : String(issue.path[0] ?? "form");
      // First error per field wins; semantic errors above take precedence.
      if (errors[field] === undefined) {
        errors[field] = issue.message;
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input: result.success ? (result.data as MonitorConfigInput) : input };
}
