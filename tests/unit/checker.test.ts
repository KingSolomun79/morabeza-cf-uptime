/**
 * Issue #6 — HTTP checker test matrix (PRD §32.1 "Checker" list).
 *
 * All outbound HTTP is mocked; response times are controlled via an injected
 * clock so tests are deterministic and fast.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runCheck,
  USER_AGENT,
  type CheckDeps,
  type MonitorCheckConfig,
} from "../../worker/services/checker";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function config(overrides: Partial<MonitorCheckConfig> = {}): MonitorCheckConfig {
  return {
    url: "https://example.com/health",
    method: "GET",
    expectedStatusCodes: [200],
    timeoutMs: 1000,
    ...overrides,
  };
}

function deps(
  fetchImpl: typeof fetch,
  overrides: Partial<CheckDeps> = {},
): CheckDeps {
  return { fetchImpl, checkId: "mon_1:slot", checkSlot: "slot", ...overrides };
}

/** Response with a controllable final URL (undici leaves `url` empty). */
function responseWithUrl(body: string | null, init: ResponseInit & { url?: string }): Response {
  const res = body === null ? new Response(null, init) : new Response(body, init);
  if (init.url) {
    Object.defineProperty(res, "url", { value: init.url, configurable: true });
  }
  return res;
}

describe("status assertions", () => {
  it("healthy: HTTP 200 within expected codes → ok", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl("fine", { status: 200 }));

    const outcome = await runCheck(config(), deps(fetchMock));

    expect(outcome).toMatchObject({
      isHealthy: true,
      reasonCode: "ok",
      statusCode: 200,
      errorMessage: null,
      assertions: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("configured non-200 status counts as healthy (PRD §10.2)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseWithUrl(null, { status: 204 }),
    );

    const outcome = await runCheck(
      config({ expectedStatusCodes: [200, 204] }),
      deps(fetchMock),
    );

    expect(outcome).toMatchObject({ isHealthy: true, reasonCode: "ok", statusCode: 204 });
  });

  it("unexpected status → unexpected_status with structured detail", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseWithUrl("server error", { status: 500 }),
    );

    const outcome = await runCheck(config(), deps(fetchMock));

    expect(outcome.isHealthy).toBe(false);
    expect(outcome.reasonCode).toBe("unexpected_status");
    expect(outcome.assertions).toEqual({
      status: { expected: [200], actual: 500 },
    });
    // Body of a status-failing response is never read.
    expect(outcome.excerpt).toBeNull();
  });

  it("records the final URL after redirects when the runtime provides it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseWithUrl("moved on", {
        status: 200,
        url: "https://example.com/final",
      }),
    );

    const outcome = await runCheck(config(), deps(fetchMock));

    expect(outcome.finalUrl).toBe("https://example.com/final");
  });

  it("falls back to the request URL when the runtime omits the final URL", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl("ok", { status: 200 }));

    const outcome = await runCheck(config(), deps(fetchMock));

    expect(outcome.finalUrl).toBe("https://example.com/health");
  });
});

describe("timeout + network errors", () => {
  it("aborted fetch → timeout (PRD §11)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const outcome = await runCheck(config({ timeoutMs: 20 }), deps(fetchMock));

    expect(outcome.isHealthy).toBe(false);
    expect(outcome.reasonCode).toBe("timeout");
    expect(outcome.statusCode).toBeNull();
  });

  it("connection failure → network_error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("fetch failed: connection refused"));

    const outcome = await runCheck(config(), deps(fetchMock));

    expect(outcome.isHealthy).toBe(false);
    expect(outcome.reasonCode).toBe("network_error");
    expect(outcome.errorMessage).toContain("connection refused");
  });
});

describe("body assertions (case-sensitive, PRD §10.2/§22)", () => {
  it("body_contains present → ok", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseWithUrl("status: ALL SYSTEMS GO", { status: 200 }),
    );

    const outcome = await runCheck(
      config({ bodyContains: "ALL SYSTEMS GO" }),
      deps(fetchMock),
    );

    expect(outcome).toMatchObject({
      isHealthy: true,
      reasonCode: "ok",
      assertions: { bodyContains: { required: "ALL SYSTEMS GO", found: true } },
    });
  });

  it("body_contains missing → body_required_text_missing with bounded excerpt", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseWithUrl("hello world", { status: 200 }),
    );

    const outcome = await runCheck(
      config({ bodyContains: "ready" }),
      deps(fetchMock),
    );

    expect(outcome.isHealthy).toBe(false);
    expect(outcome.reasonCode).toBe("body_required_text_missing");
    expect(outcome.assertions).toMatchObject({
      bodyContains: { required: "ready", found: false },
    });
    expect(outcome.excerpt).toBe("hello world");
  });

  it("body_not_contains absent → ok", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseWithUrl("everything is fine", { status: 200 }),
    );

    const outcome = await runCheck(
      config({ bodyNotContains: "ERROR" }),
      deps(fetchMock),
    );

    expect(outcome).toMatchObject({ isHealthy: true, reasonCode: "ok" });
  });

  it("body_not_contains present → body_forbidden_text_present", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseWithUrl("everything is ERROR", { status: 200 }),
    );

    const outcome = await runCheck(
      config({ bodyNotContains: "ERROR" }),
      deps(fetchMock),
    );

    expect(outcome.isHealthy).toBe(false);
    expect(outcome.reasonCode).toBe("body_forbidden_text_present");
    expect(outcome.assertions).toMatchObject({
      bodyNotContains: { forbidden: "ERROR", present: true },
    });
  });

  it("body assertions are case-sensitive: 'Down' does not match 'down'", async () => {
    // Fresh Response per call: a mock Response body can only be read once.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => responseWithUrl("we are Down right now", { status: 200 }));

    const missing = await runCheck(config({ bodyContains: "down" }), deps(fetchMock));
    const present = await runCheck(config({ bodyNotContains: "down" }), deps(fetchMock));

    expect(missing.reasonCode).toBe("body_required_text_missing");
    expect(present.reasonCode).toBe("ok");
  });
});

describe("response time ceiling (PRD §10.2)", () => {
  it("slow response → response_too_slow", async () => {
    const clock = [100, 400]; // start, end → 300ms
    const now = () => clock.shift() ?? 400;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl("ok", { status: 200 }));

    const outcome = await runCheck(
      config({ maxResponseTimeMs: 250 }),
      deps(fetchMock, { now }),
    );

    expect(outcome.isHealthy).toBe(false);
    expect(outcome.reasonCode).toBe("response_too_slow");
    expect(outcome.assertions).toEqual({
      responseTime: { maxMs: 250, actualMs: 300 },
    });
  });

  it("fast response passes and reports measured time", async () => {
    const clock = [10, 40]; // 30ms
    const now = () => clock.shift() ?? 40;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl("ok", { status: 200 }));

    const outcome = await runCheck(
      config({ maxResponseTimeMs: 250 }),
      deps(fetchMock, { now }),
    );

    expect(outcome).toMatchObject({
      isHealthy: true,
      reasonCode: "ok",
      responseTimeMs: 30,
    });
  });
});

describe("bounded body processing (PRD §10.8)", () => {
  it("stops reading after 256 KiB of a never-ending body and classifies the assertion", async () => {
    let bytesEnqueued = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        bytesEnqueued += 64 * 1024;
        controller.enqueue(new TextEncoder().encode("a".repeat(64 * 1024)));
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(stream, { status: 200 }),
    );

    const outcome = await runCheck(
      config({ bodyContains: "never-present-needle" }),
      deps(fetchMock),
    );

    expect(outcome.reasonCode).toBe("body_required_text_missing");
    // The read must have stopped at the bound, not consumed the firehose.
    expect(bytesEnqueued).toBeLessThanOrEqual(256 * 1024 + 64 * 1024);
    expect((outcome.excerpt ?? "").length).toBeLessThanOrEqual(121); // 120 chars + ellipsis
  });

  it("never persists the full body on success", async () => {
    const marker = "SECRET-PLAINTEXT-MARKER";
    const body = `${"x".repeat(400)}${marker}`;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseWithUrl(body, { status: 200 }),
    );

    const outcome = await runCheck(config({ bodyContains: "x" }), deps(fetchMock));

    expect(outcome.isHealthy).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(marker);
    expect(outcome.excerpt).toBeNull();
  });
});

describe("request construction (PRD §20)", () => {
  it("sends identifying headers and preserves allowed custom headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl("ok", { status: 200 }));

    await runCheck(
      config({ headers: { "X-Custom-Trace": "trace-42" } }),
      deps(fetchMock, { checkId: "mon_9:2026-09-05T12:31:00Z" }),
    );

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Morabeza-Uptime-Check-Id")).toBe("mon_9:2026-09-05T12:31:00Z");
    expect(headers.get("User-Agent")).toBe(USER_AGENT);
    expect(headers.get("X-Custom-Trace")).toBe("trace-42");
  });

  it("cache_bust adds a deterministic per-slot parameter and no-cache headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl("ok", { status: 200 }));

    await runCheck(config({ cacheBust: true }), deps(fetchMock, { checkSlot: "2026-09-05T12:31:00Z" }));
    await runCheck(config({ cacheBust: true }), deps(fetchMock, { checkSlot: "2026-09-05T12:31:00Z" }));

    const firstUrl = String(fetchMock.mock.calls[0]?.[0]);
    const secondUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(firstUrl).toContain("__morabeza_uptime=");
    expect(firstUrl).toBe(secondUrl); // deterministic per slot
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Cache-Control")).toBe("no-cache");

    const plainMock = vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl("ok", { status: 200 }));
    await runCheck(config({ cacheBust: false }), deps(plainMock));
    expect(String(plainMock.mock.calls[0]?.[0])).not.toContain("__morabeza_uptime");
  });

  it("POST sends the configured request body once (no hidden retries)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl(null, { status: 200 }));

    const outcome = await runCheck(
      config({ method: "POST", requestBody: '{"ping":true}' }),
      deps(fetchMock),
    );

    expect(outcome.isHealthy).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"ping":true}');
  });
});

describe("invalid targets (defense in depth; validation lives in #5)", () => {
  it("malformed URL → invalid_response without any fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    const outcome = await runCheck(config({ url: "not-a-url" }), deps(fetchMock));

    expect(outcome.isHealthy).toBe(false);
    expect(outcome.reasonCode).toBe("invalid_response");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("non-http(s) scheme → invalid_response without any fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    const outcome = await runCheck(config({ url: "ftp://example.com/file" }), deps(fetchMock));

    expect(outcome.reasonCode).toBe("invalid_response");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("HEAD monitors", () => {
  it("HEAD with body assertion does not read a body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseWithUrl(null, { status: 200 }),
    );

    const outcome = await runCheck(config({ method: "HEAD", bodyContains: "x" }), deps(fetchMock));

    // No body exists on HEAD responses; the required text is treated as missing.
    expect(outcome.reasonCode).toBe("body_required_text_missing");
    expect(outcome.excerpt).toBeNull();
  });
});
