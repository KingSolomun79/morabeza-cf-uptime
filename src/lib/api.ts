/**
 * Typed API client (issue #21; PRD §24, §38).
 *
 * Speaks the #4 envelope contract:
 *   success → `{ data: T }` (optionally `warning`);
 *   failure → `{ error: { category, message, requestId, details } }`.
 *
 * Every §38 error category is surfaced as a typed `UptimeApiError`; the
 * correlation id (`requestId`) is always carried so operators can join a
 * failed UI action to the Worker's structured logs (PRD §28/§38). A fetch
 * that never completes (offline, DNS) maps to the client-only `network`
 * category — the §38 list covers server-side categories.
 */

export const API_ERROR_CATEGORIES = [
  "validation",
  "not_found",
  "conflict",
  "authentication_required",
  "forbidden",
  "rate_limited",
  "upstream_timeout",
  "upstream_failure",
  "database_failure",
  "queue_failure",
  "email_failure",
  "internal",
] as const;

export type ApiErrorCategory = (typeof API_ERROR_CATEGORIES)[number];

/** Client-side-only category: the request never reached the API. */
export const NETWORK_CATEGORY = "network" as const;

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export class UptimeApiError extends Error {
  readonly category: ApiErrorCategory | typeof NETWORK_CATEGORY;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly details: ApiErrorDetail[] | null;

  constructor(
    category: ApiErrorCategory | typeof NETWORK_CATEGORY,
    message: string,
    options: {
      status?: number | null;
      requestId?: string | null;
      details?: ApiErrorDetail[] | null;
    } = {},
  ) {
    super(message);
    this.name = "UptimeApiError";
    this.category = category;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.details = options.details ?? null;
  }
}

function isApiErrorCategory(value: unknown): value is ApiErrorCategory {
  return (API_ERROR_CATEGORIES as readonly string[]).includes(value as string);
}

interface ErrorEnvelope {
  error?: {
    category?: unknown;
    message?: unknown;
    requestId?: unknown;
    details?: unknown;
  };
}

/** Maps a failed HTTP response (or a throw) onto the typed error shape. */
async function errorFromResponse(response: Response): Promise<UptimeApiError> {
  let envelope: ErrorEnvelope;
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    // Non-JSON error body (proxy page, empty body) — still typed, but generic.
    return new UptimeApiError("internal", response.statusText || `request failed with ${response.status}`, {
      status: response.status,
      requestId: response.headers.get("X-Request-Id"),
    });
  }
  const raw = envelope.error ?? {};
  const category = isApiErrorCategory(raw.category) ? raw.category : "internal";
  return new UptimeApiError(category, typeof raw.message === "string" ? raw.message : `request failed with ${response.status}`, {
    status: response.status,
    requestId: typeof raw.requestId === "string" ? raw.requestId : response.headers.get("X-Request-Id"),
    details: Array.isArray(raw.details) ? (raw.details as ApiErrorDetail[]) : null,
  });
}

/**
 * Performs an API call and unwraps the success envelope (`{ data }`).
 * Prefer the resource-specific wrappers; this is the shared transport.
 */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
    });
  } catch (cause) {
    throw new UptimeApiError(NETWORK_CATEGORY, cause instanceof Error ? cause.message : "network request failed");
  }

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new UptimeApiError("internal", "API returned a malformed success response", {
      status: response.status,
      requestId: response.headers.get("X-Request-Id"),
    });
  }
  // Strict envelope on /api routes; tolerate raw payloads for the few
  // non-enveloped endpoints (e.g. /healthz) so the client stays reusable.
  if (payload !== null && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

/** JSON mutation helper: sets the Content-Type the API requires (§8.4). */
export async function apiMutate<T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
