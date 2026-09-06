/**
 * @vitest-environment jsdom
 *
 * Issue #26 — System page (PRD §27.10): heartbeat indicators under the
 * shared freshness law, retention policy, email test action, dead-letter
 * ops with resolve-with-notes, and the secret-hygiene AC (no account ids /
 * tokens / secrets rendered).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SystemPage } from "../../src/pages/system-page";
import type { SystemReportDto } from "../../src/types/system";

function systemFixture(): SystemReportDto {
  return {
    now: "2026-09-06T12:00:00.000Z",
    d1: { reachable: true },
    heartbeats: {
      scheduler: { at: new Date(Date.now() - 60 * 60_000).toISOString(), status: "stale" },
      queueConsumer: { at: new Date(Date.now() - 30_000).toISOString(), status: "fresh" },
      hourlyRollup: { at: null, status: "never_run" },
      dailyRollup: { at: null, status: "never_run" },
      cleanup: { at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), status: "fresh" },
    },
    retention: { rawCheckDays: 7, hourlyDays: 90, dailyDays: 730 },
    deadLetters: { unresolved: 1 },
    version: "0.1.0",
    emailConfigured: false,
  };
}

const DEAD_LETTERS = [
  { id: "dlq_1", originalJobId: "mon_x:slot", messageType: "monitor.check", payloadSummaryJson: null, failureReason: "exhausted retries", receivedAt: "2026-09-06T10:00:00.000Z", resolvedAt: null, resolutionNotes: null },
  { id: "dlq_2", originalJobId: "mon_y:slot", messageType: "notification.send", payloadSummaryJson: null, failureReason: "email provider down", receivedAt: "2026-09-05T10:00:00.000Z", resolvedAt: "2026-09-05T11:00:00.000Z", resolutionNotes: "provider outage over" },
];

type ApiHandler = (call: { method: string; url: string; body: unknown }) => Response | null;

function envelope(data: unknown, extra: Record<string, unknown> = {}, status = 200) {
  return new Response(JSON.stringify({ data, ...extra }), { status, headers: { "Content-Type": "application/json" } });
}

function systemApi(extraHandlers: ApiHandler[] = []) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const handlers: ApiHandler[] = [
        ({ method, url }) => (method === "GET" && url === "/api/system" ? envelope(systemFixture()) : null),
        ({ method, url }) => (method === "GET" && url === "/api/notification-targets" ? envelope([{ id: "tgt_1", name: "Ops", email: "ops@morabeza.cv", enabled: true, isDefault: true }]) : null),
        ({ method, url }) => {
          if (method !== "GET" || !url.startsWith("/api/dead-letters?")) return null;
          const filter = url.split("filter=")[1]?.split("&")[0] ?? "unresolved";
          const items = DEAD_LETTERS.filter((letter) =>
            filter === "all" ? true : filter === "resolved" ? letter.resolvedAt !== null : letter.resolvedAt === null,
          );
          return envelope(items, { pagination: { total: items.length, limit: 25, offset: 0 } });
        },
        ({ method, url }) =>
          method === "POST" && url === "/api/notification-targets/tgt_1/test"
            ? envelope({ notificationEventId: "evt_new", queued: true }, {}, 202)
            : null,
        ...extraHandlers,
      ];
      for (const handler of handlers) {
        const response = handler({ method, url, body });
        if (response !== null) return response;
      }
      throw new Error(`unexpected API call: ${method} ${url}`);
    }),
  );
  return calls;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SystemPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SystemPage (PRD §27.10)", () => {
  it("renders heartbeats with obvious FRESH/STALE/NEVER RAN indicators and retention values", async () => {
    systemApi();
    renderPage();

    expect(await screen.findByText("STALE")).toBeInTheDocument(); // scheduler 1h old
    // Consumer (30s) and cleanup (3h < 26h) are both fresh.
    expect(screen.getAllByText("FRESH")).toHaveLength(2);
    expect(screen.getAllByText("NEVER RAN")).toHaveLength(2); // rollups never ran
    expect(screen.getByText("D1 REACHABLE")).toBeInTheDocument();

    expect(screen.getByText("7d")).toBeInTheDocument();
    expect(screen.getByText("90d")).toBeInTheDocument();
    expect(screen.getByText("730d")).toBeInTheDocument();
    expect(screen.getByText(/version 0\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText(/email not configured/)).toBeInTheDocument();
  });

  it("renders no secrets anywhere on the page (AC: secret hygiene)", async () => {
    systemApi();
    renderPage();
    await screen.findByText("STALE");

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/account[_\s-]?id/i);
    expect(text).not.toMatch(/api[_\s-]?key/i);
    expect(text).not.toMatch(/\btok(en)?\b/i);
    expect(text).not.toMatch(/\bsecret\b/i);
  });

  it("lists unresolved dead letters with failure reasons; resolved ones show RESOLVED", async () => {
    systemApi();
    renderPage();

    const table = await screen.findByRole("table");
    const row = within(table).getByRole("row", { name: /monitor\.check/ });
    expect(within(row).getByText("exhausted retries")).toBeInTheDocument();
    expect(screen.queryByText("RESOLVED")).not.toBeInTheDocument(); // unresolved filter default
    expect(screen.getByText("1 unresolved")).toBeInTheDocument(); // header count from /api/system
  });

  it("resolve flow PATCHes with notes and confirms before acting", async () => {
    const calls = systemApi([
      ({ method, url }) =>
        method === "PATCH" && url === "/api/dead-letters/dlq_1"
          ? envelope({ ...DEAD_LETTERS[0], resolvedAt: "2026-09-06T12:00:00.000Z", resolutionNotes: "stale job for a deleted monitor" })
          : null,
    ]);
    renderPage();
    const row = within(await screen.findByRole("table")).getByRole("row", { name: /monitor\.check/ });

    fireEvent.click(within(row).getByRole("button", { name: "Resolve" }));
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);

    fireEvent.change(within(row).getByLabelText("Resolution notes"), { target: { value: "stale job for a deleted monitor" } });
    fireEvent.click(within(row).getByRole("button", { name: "Confirm resolve" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1));
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ notes: "stale job for a deleted monitor" });
    expect(await screen.findByRole("status")).toHaveTextContent(/resolved\./);
  });

  it("switching the filter re-queries with filter=resolved", async () => {
    const calls = systemApi();
    renderPage();
    await screen.findByRole("table");

    fireEvent.change(screen.getByLabelText("Filter dead letters"), { target: { value: "resolved" } });
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("filter=resolved"))).toBe(true);
    });
  });

  it("email test action POSTs the #17 endpoint for the selected target", async () => {
    const calls = systemApi();
    renderPage();

    fireEvent.change(await screen.findByLabelText(/Send a test email/), { target: { value: "tgt_1" } });
    fireEvent.click(screen.getByRole("button", { name: /Send test/ }));
    await waitFor(() => expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/test"))).toBeTruthy());
    expect(await screen.findByRole("status")).toHaveTextContent(/Test email queued/);
  });
});
