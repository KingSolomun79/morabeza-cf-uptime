/**
 * HTTP checker — the per-check probing engine (issues #6; PRD §10, §11, §20).
 *
 * Executes exactly one outbound HTTP request for a monitor configuration and
 * classifies the outcome with a stable reason code (PRD §11). Deliberately
 * pure-ish: `fetch` and the clock are injected so tests are deterministic and
 * the queue consumer (#9) can wire it to real config loaded from D1.
 *
 * Invariants (PRD §20):
 * - no hidden retry of the outbound request;
 * - response body is read ONLY when body assertions are configured, bounded
 *   at 256 KiB, and never persisted beyond a short sanitized excerpt;
 * - identifying headers (User-Agent, X-Morabeza-Uptime-Check-Id) always set;
 * - optional cache-busting with a deterministic per-slot query parameter.
 */

export const REASON_CODES = [
  "ok",
  "timeout",
  "network_error",
  "unexpected_status",
  "body_required_text_missing",
  "body_forbidden_text_present",
  "response_too_slow",
  "invalid_response",
  "maintenance",
  "internal_error",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** The subset of monitor configuration the checker needs (mapped from D1 row). */
export interface MonitorCheckConfig {
  url: string;
  method: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  requestBody?: string | null;
  expectedStatusCodes: number[];
  bodyContains?: string | null;
  bodyNotContains?: string | null;
  maxResponseTimeMs?: number | null;
  timeoutMs: number;
  cacheBust?: boolean;
}

export interface CheckDeps {
  fetchImpl: typeof fetch;
  /** Unique id of this check; sent as X-Morabeza-Uptime-Check-Id (PRD §10.1). */
  checkId: string;
  /** Deterministic check slot (e.g. scheduledFor) used for cache-bust param. */
  checkSlot?: string;
  /** Monotonic-ish clock returning ms; injectable for deterministic tests. */
  now?: () => number;
}

export interface CheckAssertionDetail {
  status?: { expected: number[]; actual: number | null };
  bodyContains?: { required: string; found: boolean };
  bodyNotContains?: { forbidden: string; present: boolean };
  responseTime?: { maxMs: number; actualMs: number };
}

export interface CheckOutcome {
  checkId: string;
  isHealthy: boolean;
  reasonCode: ReasonCode;
  statusCode: number | null;
  responseTimeMs: number | null;
  finalUrl: string | null;
  errorMessage: string | null;
  assertions: CheckAssertionDetail | null;
  /** Short sanitized body excerpt, present only when a body assertion fails. */
  excerpt: string | null;
}

export const USER_AGENT = "Morabeza-CF-Uptime/1.0 (+https://uptime.morabeza.digital)";
const CHECK_ID_HEADER = "X-Morabeza-Uptime-Check-Id";
const CACHE_BUST_PARAM = "__morabeza_uptime";
/** PRD §10.8: never read more than 256 KiB of a response body. */
const MAX_BODY_BYTES = 256 * 1024;
const EXCERPT_MAX_CHARS = 120;
const ERROR_MAX_CHARS = 200;

export async function runCheck(
  config: MonitorCheckConfig,
  deps: CheckDeps,
): Promise<CheckOutcome> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();

  let target: URL;
  try {
    target = new URL(config.url);
  } catch {
    return buildOutcome(deps.checkId, "invalid_response", "malformed monitor URL", {
      startedAt,
      now,
    });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return buildOutcome(deps.checkId, "invalid_response", "unsupported URL scheme", {
      startedAt,
      now,
    });
  }

  // Build request: allowed custom headers + identifying headers (+ optional
  // cache-busting), PRD §20 steps 5–8.
  const headers: Record<string, string> = { ...config.headers };
  headers["User-Agent"] = USER_AGENT;
  headers[CHECK_ID_HEADER] = deps.checkId;

  let requestUrl = target.toString();
  if (config.cacheBust) {
    headers["Cache-Control"] = "no-cache";
    headers["Pragma"] = "no-cache";
    const bustValue = encodeURIComponent(deps.checkSlot ?? deps.checkId);
    const separator = requestUrl.includes("?") ? "&" : "?";
    requestUrl = `${requestUrl}${separator}${CACHE_BUST_PARAM}=${bustValue}`;
  }

  // Single fetch with abort timeout; no hidden retries (PRD §20).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response: Response;
  try {
    response = await deps.fetchImpl(requestUrl, {
      method: config.method,
      headers,
      body: config.method === "POST" ? (config.requestBody ?? "") : undefined,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const err = error as Error;
    const timedOut = err?.name === "AbortError" || err?.name === "TimeoutError";
    return buildOutcome(deps.checkId, timedOut ? "timeout" : "network_error", err?.message ?? String(error), {
      startedAt,
      now,
    });
  }
  clearTimeout(timer);

  const responseTimeMs = elapsed(startedAt, now);
  const finalUrl = response.url || requestUrl;
  const statusCode = response.status;
  const assertions: CheckAssertionDetail = {};

  // Assertion 1: expected status codes (PRD §10.2).
  if (!config.expectedStatusCodes.includes(statusCode)) {
    await discardBody(response);
    assertions.status = { expected: [...config.expectedStatusCodes], actual: statusCode };
    return buildOutcome(deps.checkId, "unexpected_status", `unexpected HTTP status ${statusCode}`, {
      startedAt,
      now,
      responseTimeMs,
      finalUrl,
      statusCode,
      assertions,
    });
  }

  // Assertions 2–3: body contains / not-contains, case-sensitive (PRD §10.2,
  // §22). Body is read ONLY here, bounded (PRD §10.8).
  const needsBody = Boolean(config.bodyContains) || Boolean(config.bodyNotContains);
  let bodyText: string | null = null;
  let bounded = false;
  if (needsBody && config.method !== "HEAD") {
    try {
      const read = await readBoundedBody(response);
      bodyText = read.text;
      bounded = read.truncated;
    } catch (error) {
      const err = error as Error;
      const timedOut = err?.name === "AbortError" || err?.name === "TimeoutError";
      return buildOutcome(
        deps.checkId,
        timedOut ? "timeout" : "network_error",
        err?.message ?? String(error),
        { startedAt, now, responseTimeMs, finalUrl, statusCode },
      );
    }
  }

  if (config.bodyContains) {
    const found = bodyText?.includes(config.bodyContains) ?? false;
    assertions.bodyContains = { required: config.bodyContains, found };
    if (!found) {
      const suffix = bounded ? ` (body read bounded at ${MAX_BODY_BYTES} bytes)` : "";
      return buildOutcome(
        deps.checkId,
        "body_required_text_missing",
        `required text not present in response body${suffix}`,
        { startedAt, now, responseTimeMs, finalUrl, statusCode, assertions, bodyText },
      );
    }
  }

  if (config.bodyNotContains) {
    const present = bodyText?.includes(config.bodyNotContains) ?? false;
    assertions.bodyNotContains = { forbidden: config.bodyNotContains, present };
    if (present) {
      return buildOutcome(
        deps.checkId,
        "body_forbidden_text_present",
        "forbidden text present in response body",
        { startedAt, now, responseTimeMs, finalUrl, statusCode, assertions, bodyText },
      );
    }
  }

  // Assertion 4: maximum response time.
  if (config.maxResponseTimeMs != null && responseTimeMs > config.maxResponseTimeMs) {
    assertions.responseTime = { maxMs: config.maxResponseTimeMs, actualMs: responseTimeMs };
    return buildOutcome(
      deps.checkId,
      "response_too_slow",
      `response time ${responseTimeMs}ms exceeded ${config.maxResponseTimeMs}ms`,
      { startedAt, now, responseTimeMs, finalUrl, statusCode, assertions },
    );
  }

  return buildOutcome(deps.checkId, "ok", null, {
    startedAt,
    now,
    responseTimeMs,
    finalUrl,
    statusCode,
    assertions,
  });
}

interface OutcomeInput {
  startedAt: number;
  now: () => number;
  responseTimeMs?: number;
  finalUrl?: string;
  statusCode?: number;
  assertions?: CheckAssertionDetail;
  bodyText?: string | null;
}

function buildOutcome(
  checkId: string,
  reasonCode: ReasonCode,
  errorMessage: string | null,
  input: OutcomeInput,
): CheckOutcome {
  const assertions = input.assertions;
  return {
    checkId,
    isHealthy: reasonCode === "ok",
    reasonCode,
    statusCode: input.statusCode ?? null,
    responseTimeMs:
      input.responseTimeMs ?? elapsed(input.startedAt, input.now),
    finalUrl: input.finalUrl ?? null,
    errorMessage: errorMessage ? sanitizeMessage(errorMessage) : null,
    assertions: assertions && Object.keys(assertions).length > 0 ? assertions : null,
    excerpt:
      reasonCode === "body_required_text_missing" || reasonCode === "body_forbidden_text_present"
        ? excerptFrom(input.bodyText ?? null)
        : null,
  };
}

function elapsed(startedAt: number, now: () => number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

/**
 * Reads at most MAX_BODY_BYTES of the response body and stops reading
 * (cancels the stream) after the bound — PRD §10.8.
 */
async function readBoundedBody(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: "", truncated: false };
  }
  const decoder = new TextDecoder("utf-8");
  const reader = response.body.getReader();
  let received = 0;
  let text = "";
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (received >= MAX_BODY_BYTES) {
      truncated = true;
      void reader.cancel().catch(() => undefined);
      break;
    }
  }
  text += decoder.decode();
  return { text, truncated };
}

/** Politely discards a body we do not need to read. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // discarding is best-effort only
  }
}

function sanitizeMessage(message: string): string {
  // Stripping control characters is exactly the point of this regex.
  // eslint-disable-next-line no-control-regex
  const cleaned = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.length > ERROR_MAX_CHARS
    ? `${cleaned.slice(0, ERROR_MAX_CHARS)}…`
    : cleaned;
}

function excerptFrom(text: string | null): string | null {
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > EXCERPT_MAX_CHARS
    ? `${collapsed.slice(0, EXCERPT_MAX_CHARS)}…`
    : collapsed;
}
