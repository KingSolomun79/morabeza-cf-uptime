/**
 * @vitest-environment jsdom
 *
 * Issue #22 — Overview page: aggregate-driven rendering, filter
 * combinations, empty state, and table a11y basics (PRD §27.3).
 * fetch is mocked; the dashboard payload mirrors the #22 API contract.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OverviewPage } from "../../src/pages/overview";
import type { DashboardDto } from "../../src/types/dashboard";

function fixture(): DashboardDto {
  return {
    counts: {
      totalActive: 3,
      up: 1,
      down: 1,
      unknown: 1,
      paused: 0,
      inMaintenance: 1,
      openIncidents: 1,
    },
    recentRecoveries: [
      { id: "inc_1", monitorId: "mon_1", monitorName: "Alpha Site", resolvedAt: "2026-09-06T09:00:00.000Z", outageDurationMs: 300000 },
    ],
    trend: [
      { hourStart: "2026-09-06T10:00:00.000Z", avgResponseTimeMs: 120 },
      { hourStart: "2026-09-06T11:00:00.000Z", avgResponseTimeMs: 180 },
    ],
    heartbeat: { status: "ok", checks: { d1: true, scheduler: true, consumer: true } },
    monitors: [
      {
        id: "mon_1",
        clientId: "cli_a",
        clientName: "Alpha",
        name: "Alpha Site",
        status: "up",
        inMaintenance: false,
        uptime24h: { status: "ok", percentage: 75, eligibleChecks: 4 },
        lastResponseTimeMs: 120,
        lastCheckedAt: "2026-09-06T11:58:00.000Z",
        openIncidentId: null,
      },
      {
        id: "mon_2",
        clientId: "cli_b",
        clientName: "Beta",
        name: "Beta Portal",
        status: "down",
        inMaintenance: true,
        uptime24h: { status: "ok", percentage: 40, eligibleChecks: 5 },
        lastResponseTimeMs: 210,
        lastCheckedAt: "2026-09-06T11:59:00.000Z",
        openIncidentId: "inc_open_1",
      },
      {
        id: "mon_3",
        clientId: "cli_b",
        clientName: "Beta",
        name: "Beta New",
        status: "unknown",
        inMaintenance: false,
        uptime24h: { status: "no_data", percentage: null, eligibleChecks: 0 },
        lastResponseTimeMs: null,
        lastCheckedAt: null,
        openIncidentId: null,
      },
    ],
  };
}

function renderOverview(fetchPayload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ data: fetchPayload }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OverviewPage (PRD §27.3)", () => {
  it("renders stat cards, heartbeat state, and the monitor table for mixed statuses", async () => {
    renderOverview(fixture());

    expect(await screen.findByText("System healthy")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Open incidents")).toBeInTheDocument();

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Client" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "24h uptime" })).toBeInTheDocument();

    // Mixed statuses render the shared vocabulary; the in-maintenance row
    // displays the maintenance overlay.
    expect(within(table).getByText("UP")).toBeInTheDocument();
    expect(within(table).getByText("MAINTENANCE")).toBeInTheDocument();
    expect(within(table).getByText("UNKNOWN")).toBeInTheDocument();

    // Uptime cells: exact percentage + explicit no-data (never "100%").
    expect(within(table).getByText("75.00%")).toBeInTheDocument();
    expect(within(table).getAllByText("No data")).toHaveLength(1);
    // Incident column marks the open incident.
    expect(within(table).getByText("Open")).toBeInTheDocument();
  });

  it("renders a sparkline for the response-time trend", async () => {
    renderOverview(fixture());
    expect(await screen.findByRole("img", { name: /average response time per hour/i })).toBeInTheDocument();
  });

  it("filters by status through the select (client + status + search are wired)", async () => {
    renderOverview(fixture());
    await screen.findByRole("table");

    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "down" } });
    const table = screen.getByRole("table");
    expect(within(table).getByText("Beta Portal")).toBeInTheDocument();
    expect(within(table).queryByText("Alpha Site")).not.toBeInTheDocument();
  });

  it("searches across monitor and client names", async () => {
    renderOverview(fixture());
    await screen.findByRole("table");

    fireEvent.change(screen.getByLabelText("Search monitors"), { target: { value: "beta new" } });
    const table = screen.getByRole("table");
    expect(within(table).getByText("Beta New")).toBeInTheDocument();
    expect(within(table).queryByText("Alpha Site")).not.toBeInTheDocument();
  });

  it("shows the no-monitors empty state instead of a table", async () => {
    const empty = fixture();
    empty.monitors = [];
    empty.trend = [];
    empty.recentRecoveries = [];
    renderOverview(empty);

    expect(await screen.findByText("No monitors yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("surfaces API failures with the typed category and correlation id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { category: "database_failure", message: "D1 unavailable", requestId: "req_dash_9", details: null } }),
          { status: 500 },
        ),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <OverviewPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Overview unavailable")).toBeInTheDocument();
    expect(screen.getByText(/database_failure/)).toBeInTheDocument();
    expect(screen.getByText(/req_dash_9/)).toBeInTheDocument();
  });
});
