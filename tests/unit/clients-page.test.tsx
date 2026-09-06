/**
 * @vitest-environment jsdom
 *
 * Issue #25 — Clients pages (PRD §27.6): list rollups from the #22
 * dashboard aggregate (counts, open incidents, aggregate uptime), client
 * CRUD against #4, archive confirm guard, and the detail route.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClientsPage, ClientDetailPage } from "../../src/pages/clients-page";
import type { ClientDto } from "../../src/types/monitor";
import type { DashboardDto } from "../../src/types/dashboard";

const NOW = "2026-09-06T12:00:00.000Z";

function client(id: string, name: string, slug: string): ClientDto {
  return { id, name, slug, active: true, notes: null, createdAt: NOW, updatedAt: NOW, archivedAt: null };
}

const CLIENTS: ClientDto[] = [client("cli_1", "Alpha Ltd", "alpha-ltd"), client("cli_2", "Beta Sarl", "beta-sarl")];

const DASHBOARD: DashboardDto = {
  counts: { totalActive: 3, up: 1, down: 1, unknown: 1, paused: 0, inMaintenance: 0, openIncidents: 1 },
  recentRecoveries: [],
  trend: [],
  heartbeat: { status: "ok", checks: { d1: true, scheduler: true, consumer: true } },
  monitors: [
    { id: "mon_1", clientId: "cli_1", clientName: "Alpha Ltd", name: "Alpha Home", status: "up", inMaintenance: false, uptime24h: { status: "ok", percentage: 100, eligibleChecks: 10 }, lastResponseTimeMs: 100, lastCheckedAt: NOW, openIncidentId: null },
    { id: "mon_2", clientId: "cli_1", clientName: "Alpha Ltd", name: "Alpha API", status: "down", inMaintenance: false, uptime24h: { status: "ok", percentage: 95, eligibleChecks: 10 }, lastResponseTimeMs: 120, lastCheckedAt: NOW, openIncidentId: "inc_1" },
    { id: "mon_3", clientId: "cli_2", clientName: "Beta Sarl", name: "Beta Site", status: "unknown", inMaintenance: false, uptime24h: { status: "no_data", percentage: null, eligibleChecks: 0 }, lastResponseTimeMs: null, lastCheckedAt: null, openIncidentId: null },
  ],
};

type ApiHandler = (call: { method: string; url: string; body: unknown }) => Response | null;

function envelope(data: unknown, extra: Record<string, unknown> = {}, status = 200) {
  return new Response(JSON.stringify({ data, ...extra }), { status, headers: { "Content-Type": "application/json" } });
}

function clientsApi(extraHandlers: ApiHandler[] = []) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const handlers: ApiHandler[] = [
        ({ method, url }) => (method === "GET" && url === "/api/clients" ? envelope(CLIENTS) : null),
        ({ method, url }) => (method === "GET" && url === "/api/dashboard" ? envelope(DASHBOARD) : null),
        ({ method, url }) =>
          method === "GET" && url.startsWith("/api/incidents")
            ? envelope([{ id: "inc_1", monitorId: "mon_2", status: "open", openedAt: NOW, firstFailureAt: NOW, resolvedAt: null, triggerCheckId: null, recoveryCheckId: null, openReasonCode: "unexpected_status", outageDurationMs: null, resolutionReason: null, createdAt: NOW, updatedAt: NOW }], { pagination: { total: 1, limit: 200, offset: 0 } })
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

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="clients" element={<ClientsPage />} />
          <Route path="clients/:id" element={<ClientDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ClientsPage list (§27.6)", () => {
  it("renders per-client rollups: counts, open incidents, aggregate uptime mean", async () => {
    clientsApi();
    renderAt("/clients");

    const table = await screen.findByRole("table");
    const alphaRow = within(table).getByRole("row", { name: /Alpha Ltd/ });
    // 2 monitors, 1 up / 1 down / 0 paused, 1 open incident, mean(100, 95) = 97.50%.
    expect(within(alphaRow).getByText("2")).toBeInTheDocument();
    expect(within(alphaRow).getByText("1 / 1 / 0")).toBeInTheDocument();
    expect(within(alphaRow).getByText("97.50%")).toBeInTheDocument();
    const betaRow = within(table).getByRole("row", { name: /Beta Sarl/ });
    expect(within(betaRow).getByText("No data")).toBeInTheDocument();
  });

  it("creates a client through the #4 endpoint after client-side slug validation", async () => {
    const calls = clientsApi([
      ({ method }) => (method === "POST" ? envelope(client("cli_9", "Gamma", "gamma"), {}, 201) : null),
    ]);
    renderAt("/clients");
    fireEvent.click(await screen.findByRole("button", { name: "New client" }));

    // Invalid slug → inline error, no POST.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Gamma" } });
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "Gamma!!" } });
    fireEvent.click(screen.getByRole("button", { name: "Create client" }));
    expect(await screen.findByText(/slug must be lowercase/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "gamma" } });
    fireEvent.click(screen.getByRole("button", { name: "Create client" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ name: "Gamma", slug: "gamma", notes: null });
  });

  it("guards archive behind a confirm step (no hard delete)", async () => {
    const calls = clientsApi([
      ({ method, url }) => (method === "DELETE" && url === "/api/clients/cli_1" ? envelope(client("cli_1", "Alpha Ltd", "alpha-ltd")) : null),
    ]);
    renderAt("/clients");
    const row = within(await screen.findByRole("table")).getByRole("row", { name: /Alpha Ltd/ });

    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    fireEvent.click(within(row).getByRole("button", { name: "Confirm archive" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1));
  });
});

describe("ClientDetailPage (§27.6)", () => {
  it("shows counts, aggregate uptime, member monitors, and the client's open incident", async () => {
    clientsApi();
    renderAt("/clients/cli_1");

    expect(await screen.findByRole("heading", { name: "Alpha Ltd" })).toBeInTheDocument();
    expect(screen.getByText("Alpha Home")).toBeInTheDocument();
    expect(screen.getByText("Alpha API")).toBeInTheDocument();
    expect(screen.getByText("97.50%")).toBeInTheDocument();
    // Exactly one open incident row, linked to the incident detail route.
    const incidentLink = screen.getByRole("link", { name: "Incident" });
    expect(incidentLink).toHaveAttribute("href", "/incidents/inc_1");
    // The member list links into the monitor detail deep link.
    expect(screen.getByRole("link", { name: "Alpha Home" })).toHaveAttribute("href", "/monitors/mon_1");
  });

  it("renders a not-found card for an unknown client id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    renderAt("/clients/cli_nope");
    expect(await screen.findByText("Client not found")).toBeInTheDocument();
  });
});
