/**
 * Zod-based input validation helpers (PRD §29.7: input validation through Zod).
 */
import type { Context } from "hono";
import type { ZodType } from "zod";
import { ApiError, type ErrorDetail } from "./errors";
import type { AppEnv } from "../env";

export function zodIssuesToDetails(issues: Array<{ path: PropertyKey[]; message: string }>): ErrorDetail[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "body",
    message: issue.message,
  }));
}

/**
 * Enforces JSON content type and parses + validates the request body against
 * a Zod schema (PRD §8.4: accept JSON only on JSON mutation routes).
 * Throws ApiError("validation") with field-level details on failure.
 */
export async function parseJsonBody<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw ApiError.validation("Content-Type must be application/json", [
      { path: "headers.content-type", message: "expected application/json" },
    ]);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw ApiError.validation("request body is not valid JSON");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.validation("request body is invalid", zodIssuesToDetails(parsed.error.issues));
  }
  return parsed.data;
}

/** Reads and validates query parameters against a Zod schema. */
export function parseQuery<T>(c: Context<AppEnv>, schema: ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw ApiError.validation("query parameters are invalid", zodIssuesToDetails(parsed.error.issues));
  }
  return parsed.data;
}
