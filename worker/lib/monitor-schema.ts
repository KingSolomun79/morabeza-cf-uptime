/**
 * Monitor create/update validation (issues #5; PRD §10, §22).
 *
 * Reused by the API (#5), the duplicate-detection warning, and bulk import
 * (#27) so there is exactly one validator. Body assertions are case-sensitive
 * in V1 (PRD §22); security-sensitive header names are rejected (PRD §10.9).
 */
import { z } from "zod";
import { MAX_URL_LENGTH, validateMonitorUrl } from "./url-safety";

export const INTERVAL_CHOICES = [60, 120, 300, 600] as const;
export const ALLOWED_METHODS = ["GET", "HEAD", "POST"] as const;

export const MAX_HEADERS = 25;
export const MAX_HEADER_NAME_LENGTH = 128;
export const MAX_HEADER_VALUE_LENGTH = 4096;
export const MAX_BODY_ASSERTION_LENGTH = 1024;
export const MAX_REQUEST_BODY_LENGTH = 8 * 1024;
const HEADER_SECRET_PARTS = new Set([
  "auth",
  "authorization",
  "token",
  "key",
  "apikey",
  "secret",
  "password",
  "credential",
  "credentials",
  "cookie",
  "session",
  "signature",
]);

/** True for header names V1 treats as secret-bearing (PRD §10.9). */
export function isSensitiveHeaderName(name: string): boolean {
  const parts = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return parts.some((part) => HEADER_SECRET_PARTS.has(part));
}

const headerObjectSchema = z
  .record(z.string().min(1), z.string())
  .refine((headers) => Object.keys(headers).length <= MAX_HEADERS, `at most ${MAX_HEADERS} headers`)
  .refine(
    (headers) => Object.keys(headers).every((name) => name.length <= MAX_HEADER_NAME_LENGTH),
    `header names are capped at ${MAX_HEADER_NAME_LENGTH} characters`,
  )
  .refine(
    (headers) => Object.values(headers).every((value) => value.length <= MAX_HEADER_VALUE_LENGTH),
    `header values are capped at ${MAX_HEADER_VALUE_LENGTH} characters`,
  );

export const monitorBaseSchema = z.object({
  clientId: z.string().min(1, "client is required"),
  name: z.string().trim().min(1).max(200),
  url: z
    .string()
    .min(1, "url is required")
    .max(MAX_URL_LENGTH)
    .refine((value) => validateMonitorUrl(value).ok, "url is not an allowed public http(s) target")
    .transform((value) => {
      const result = validateMonitorUrl(value);
      return result.ok ? result.normalized : value;
    }),
  method: z.enum(ALLOWED_METHODS).default("GET"),
  headers: headerObjectSchema.nullish().transform((value) => value ?? null),
  requestBody: z.string().max(MAX_REQUEST_BODY_LENGTH).nullish().transform((value) => value ?? null),
  expectedStatusCodes: z
    .array(z.number().int().min(100).max(599))
    .min(1, "at least one expected status code")
    .max(20)
    .default([200]),
  bodyContains: z.string().min(1).max(MAX_BODY_ASSERTION_LENGTH).nullish().transform((value) => value ?? null),
  bodyNotContains: z.string().min(1).max(MAX_BODY_ASSERTION_LENGTH).nullish().transform((value) => value ?? null),
  maxResponseTimeMs: z.number().int().positive().max(60000).nullish().transform((value) => value ?? null),
  intervalSeconds: z
    .number()
    .int()
    .refine((value) => (INTERVAL_CHOICES as readonly number[]).includes(value), {
      message: "interval must be one of 60, 120, 300, or 600 seconds",
    })
    .default(300),
  timeoutMs: z.number().int().min(1000).max(60000).default(10000),
  failureThreshold: z.number().int().min(1).max(10).default(3),
  recoveryThreshold: z.number().int().min(1).max(10).default(2),
  cacheBust: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(50)).max(25).nullish().transform((value) => value ?? null),
});

export const createMonitorSchema = monitorBaseSchema;

export const updateMonitorSchema = monitorBaseSchema
  .partial()
  .extend({
    /** Explicit enable/disable toggle (PRD §23). Absent = unchanged. */
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "update body is empty");

export type CreateMonitorInput = z.output<typeof createMonitorSchema>;
export type UpdateMonitorInput = z.output<typeof updateMonitorSchema>;

/** Sensitive-header enforcement as a separate step so errors are precise. */
export function findSensitiveHeader(headers: Record<string, string> | null): string | null {
  if (!headers) return null;
  for (const name of Object.keys(headers)) {
    if (isSensitiveHeaderName(name)) return name;
  }
  return null;
}

/** POST bodies only make sense for POST monitors. */
export function findConfigConflicts(input: { method: string; requestBody: string | null }): string | null {
  if (input.method !== "POST" && input.requestBody) {
    return "requestBody is only allowed for POST monitors";
  }
  return null;
}
