/**
 * Stable API error categories and the JSON error envelope (PRD §38).
 *
 * API responses must not leak stack traces or internals in production —
 * unknown errors collapse to `internal` with a sanitized message; the real
 * error goes to structured logs with the same requestId (worker/lib/logging).
 */

export const ERROR_CATEGORIES = [
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

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  authentication_required: 401,
  forbidden: 403,
  rate_limited: 429,
  upstream_timeout: 504,
  upstream_failure: 502,
  database_failure: 500,
  queue_failure: 500,
  email_failure: 500,
  internal: 500,
};

export interface ErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly category: ErrorCategory;
  readonly status: number;
  readonly details: ErrorDetail[] | null;

  constructor(category: ErrorCategory, message: string, details: ErrorDetail[] | null = null) {
    super(message);
    this.name = "ApiError";
    this.category = category;
    this.status = STATUS_BY_CATEGORY[category];
    this.details = details;
  }

  static validation(message = "request is invalid", details: ErrorDetail[] | null = null): ApiError {
    return new ApiError("validation", message, details ?? undefined);
  }

  static notFound(message = "resource not found"): ApiError {
    return new ApiError("not_found", message);
  }

  static conflict(message: string): ApiError {
    return new ApiError("conflict", message);
  }

  static authenticationRequired(message = "authentication required"): ApiError {
    return new ApiError("authentication_required", message);
  }

  static forbidden(message = "forbidden"): ApiError {
    return new ApiError("forbidden", message);
  }

  static internal(message = "internal server error"): ApiError {
    return new ApiError("internal", message);
  }
}

export interface ErrorEnvelope {
  error: {
    category: ErrorCategory;
    message: string;
    requestId: string;
    details: ErrorDetail[] | null;
  };
}

export function errorEnvelope(err: ApiError, requestId: string): ErrorEnvelope {
  return {
    error: {
      category: err.category,
      message: err.message,
      requestId,
      details: err.details,
    },
  };
}
