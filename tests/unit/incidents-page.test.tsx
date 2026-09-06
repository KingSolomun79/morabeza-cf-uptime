/**
 * @vitest-environment jsdom
 *
 * Issue #25 — Incidents pages (PRD §27.7): open-first paginated list and
 * the full incident detail incl. the related-check timeline (§13 data +
 * #24 checks endpoint). /incidents/:id is the #17 email deep link.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IncidentsPage, IncidentDetailPage } from "../../src/pages/incidents-page";
import type { MonitorIncidentDto } from "../../src/types/monitor-detail";

function incident(patch: Partial<MonitorIncidentDto>): MonitorIncidentDto {
  return {
    id: "inc_1",
    monitorId: "mon_1",
    status: "open",
    openedAt: "2026-09-05T10:00:00.000Z",
    firstFailureAt: "2026-09-05T09:58:00.000Z",
    resolvedAt: null,
    triggerCheckId: "chk_trigger",
    recoveryCheckId: null,
    openReasonCode: "unexpected_status",
    outageDurationMs: null,
    resolutionReason: null,
    createdAt: "2026-09-05T10:00:00.000Z",
    updatedAt: "2026-09-05T10:00:00.000Z",
    ...patch,
  };
}

const OPEN = incident({});
const RESOLVED = incident({
  id: "inc_2",
  status: "resolved",
  openedAt: "2026-09-05T10:00:00.000Z",
  firstFailureAt: "2026-09-05T09:58:00.000Z",
  resolvedAt: "2026-09-05T10:20:00.000Z",
  recoveryCheckId: "chk_recovery",
  resolutionReason: "recovered",
  outageDurationMs: 1_200_000, // 20m
});

type ApiHandler = (call: { method: string; url: string; body: unknown }) => Response | null;

function envelope(data: unknown, extra: Record<string, unknown> = {}, status = 200) {
  return new Response(JSON.stringify({ data, ...extra }), { status, headers: { "Content-Type": "application/json" } });
}

const MONITOR = { id: "mon_1", clientId: "cli_1", name: "Alpha Site", url: "https://a.example.com/", method: "GET", headers: null, requestBody: null, expectedStatusCodes: [200], bodyContains: null, bodyNotContains: null, maxResponseTimeMs: null, intervalSeconds: 300, timeoutMs: 10000, failureThreshold: 3, recoveryThreshold: 2, cacheBust: false, enabled: true, tags: null, nextCheckAt: "", createdAt: "", updatedAt: "", archivedAt: null, state: null };

function incidentsApi(extraHandlers: ApiHandler[] = []) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const handlers: ApiHandler[] = [
        ({ method, url }) => {
          if (method !== "GET" || !url.startsWith("/api/incidents?")) return null;
          const offset = Number(new URLSearchParams(url.split("?")[1]).get("offset") ?? 0);
          const all = [OPEN, RESOLVED];
          return envelope(all.slice(offset, offset + 25), { pagination: { total: all.length, limit: 25, offset } });
        },
        ({ method, url }) => {
          if (method !== "GET" || !url.startsWith("/api/incidents/inc_")) return null;
          return envelope(url.endsWith("inc_1") ? OPEN : RESOLVED);
        },
        ({ method, url }) => (method === "GET" && url === "/api/monitors/mon_1" ? envelope(MONITOR) : null),
        ({ method, url }) => (method === "GET" && url === "/api/monitors?includeArchived=false" ? envelope([MONITOR]) : null),
        ({ method, url }) => (method === "GET" && url === "/api/clients" ? envelope([{ id: "cli_1", name: "Alpha Ltd", slug: "alpha-ltd", active: true, notes: null, createdAt: "", updatedAt: "", archivedAt: null }]) : null),
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

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="incidents" element={<IncidentsPage />} />
          <Route path="incidents/:id" element={<IncidentDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("IncidentsPage list (§27.7)", () => {
  it("renders the server's open-first order with monitor/client/duration columns", async () => {
    incidentsApi();
    renderAt("/incidents");

    const table = await screen.findByRole("table");
    // Monitor names arrive from a second query — wait for them to land.
    const rows = within(table).getAllByRole("row");
    await within(rows[2]).findByText("Alpha Site");
    // Header + 2 rows; the OPEN incident must come before the RESOLVED one.
    expect(within(rows[1]).getByText("OPEN")).toBeInTheDocument();
    expect(within(rows[2]).getByText("RESOLVED")).toBeInTheDocument();
    expect(within(rows[2]).getByText("20m")).toBeInTheDocument();
    expect(within(rows[1]).getByText("unexpected_status")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Alpha Site")).toBeInTheDocument();
  });

  it("hides pagination controls' Next when everything fits on one page", async () => {
    incidentsApi();
    renderAt("/incidents");
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });
});

describe("IncidentDetailPage (§27.7 field set)", () => {
  function timelineApi() {
    return incidentsApi([
      ({ method, url }) => {
        if (method !== "GET" || !url.startsWith("/api/monitors/mon_1/checks?")) return null;
        // Oldest first is what the pipeline writes; the UI re-sorts anyway.
        const checks = [
          { id: "chk_old", monitorId: "mon_1", source: "scheduled", completedAt: "2026-09-05T08:00:00.000Z", isHealthy: true, maintenanceExcluded: false, statusCode: 200, responseTimeMs: 100, reasonCode: "ok", errorMessage: null },
          { id: "chk_trigger", monitorId: "mon_1", source: "scheduled", completedAt: "2026-09-05T09:58:00.000Z", isHealthy: false, maintenanceExcluded: false, statusCode: 503, responseTimeMs: 200, reasonCode: "unexpected_status", errorMessage: "expected 200, got 503" },
          { id: "chk_mid", monitorId: "mon_1", source: "scheduled", completedAt: "2026-09-05T10:05:00.000Z", isHealthy: false, maintenanceExcluded: false, statusCode: 503, responseTimeMs: 210, reasonCode: "unexpected_status", errorMessage: null },
          { id: "chk_recovery", monitorId: "mon_1", source: "scheduled", completedAt: "2026-09-05T10:20:00.000Z", isHealthy: true, maintenanceExcluded: false, statusCode: 200, responseTimeMs: 120, reasonCode: "ok", errorMessage: null },
          { id: "chk_new", monitorId: "mon_1", source: "scheduled", completedAt: "2026-09-05T12:00:00.000Z", isHealthy: true, maintenanceExcluded: false, statusCode: 200, responseTimeMs: 130, reasonCode: "ok", errorMessage: null },
        ];
        return envelope(checks, { pagination: { total: checks.length, limit: 200, offset: 0 } });
      },
    ]);
  }

  it("renders every §27.7 field for the resolved fixture", async () => {
    timelineApi();
    renderAt("/incidents/inc_2");

    expect(await screen.findByRole("heading", { name: "Incident" })).toBeInTheDocument();
    expect(screen.getByText("RESOLVED")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Alpha Site" })).toHaveAttribute("href", "/monitors/mon_1");
    expect(await screen.findByRole("link", { name: "Alpha Ltd" })).toHaveAttribute("href", "/clients/cli_1");
    // First failure vs threshold crossing are distinct fields. The first
    // failure timestamp also appears on the trigger timeline row, and the
    // open reason on every failed row, hence getAllByText:
    expect(screen.getAllByText("2026-09-05 08:58").length).toBeGreaterThan(0); // first failure, Cape_Verde −1h
    expect(screen.getByText("2026-09-05 09:00")).toBeInTheDocument(); // openedAt
    expect(screen.getAllByText("unexpected_status").length).toBeGreaterThan(0);
    expect(screen.getByText("chk_trigger")).toBeInTheDocument();
    expect(screen.getByText(/recovered/)).toBeInTheDocument();
    expect(screen.getByText("20m")).toBeInTheDocument();
  });

  it("builds the related-check timeline: trigger/recovery badges, window filtering", async () => {
    timelineApi();
    renderAt("/incidents/inc_2");

    await screen.findByText("THRESHOLD");
    expect(screen.getByText("RECOVERY")).toBeInTheDocument();
    // The 10:05 check inside the window shows; 08:00 and 12:00 (outside) don't.
    expect(screen.getByText("2026-09-05 09:05")).toBeInTheDocument();
    expect(screen.queryByText("2026-09-05 07:00")).not.toBeInTheDocument();
    expect(screen.queryByText("2026-09-05 11:00")).not.toBeInTheDocument();
  });

  it("renders a not-found card for an unknown incident id (deep-link safety)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { category: "not_found", message: "incident not found", requestId: "req_9", details: null } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    renderAt("/incidents/inc_nope");
    expect(await screen.findByText("Incident not found")).toBeInTheDocument();
  });
});
