/**
 * @vitest-environment jsdom
 *
 * Issue #24 — Monitor detail page (PRD §27.5): config summary, uptime
 * windows, checks table with pagination + manual/maintenance flags,
 * incidents list, notification-target quick-edit, run-now, and the
 * response-time chart with a labeled maintenance overlay. fetch is mocked
 * at the envelope level.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MonitorDetailPage } from "../../src/pages/monitor-detail-page";
import type { MonitorDto } from "../../src/types/monitor";
import type { CheckDto, MaintenanceWindowDto, MonitorIncidentDto, NotificationTargetDto, UptimeDto } from "../../src/types/monitor-detail";

function monitorFixture(patch: Partial<MonitorDto> = {}): MonitorDto {
  return {
    id: "mon_1",
    clientId: "cli_1",
    name: "Alpha Site",
    url: "https://alpha.example.com/health",
    method: "GET",
    headers: null,
    requestBody: null,
    expectedStatusCodes: [200],
    bodyContains: "ok",
    bodyNotContains: null,
    maxResponseTimeMs: 2000,
    intervalSeconds: 300,
    timeoutMs: 10000,
    failureThreshold: 3,
    recoveryThreshold: 2,
    cacheBust: false,
    enabled: true,
    tags: ["prod"],
    nextCheckAt: "2026-09-06T12:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    state: { status: "up", lastCheckedAt: new Date(Date.now() - 5 * 60_000).toISOString(), lastStatusCode: 200, lastResponseTimeMs: 120, lastReasonCode: null },
    ...patch,
  };
}

const TOTAL_CHECKS = 30;

function checkFixture(index: number): CheckDto {
  const completedAt = new Date(Date.now() - (TOTAL_CHECKS - index) * 5 * 60_000).toISOString();
  // Checks 16–21 complete 70–45 min ago — inside mw_active ([70m, 40m) ago,
  // half-open), so the table's Excluded flags and the chart overlay agree.
  const maintenance = index >= 16 && index <= 21;
  return {
    id: `chk_${index}`,
    monitorId: "mon_1",
    source: index === 4 ? "manual" : "scheduled",
    completedAt,
    isHealthy: index !== 7,
    maintenanceExcluded: maintenance,
    statusCode: maintenance ? null : index === 7 ? 503 : 200,
    responseTimeMs: maintenance ? null : 100 + index,
    reasonCode: maintenance ? "maintenance_skip" : index === 7 ? "unexpected_status" : "ok",
    errorMessage: index === 7 ? "expected 200, got 503" : null,
  };
}

function uptimeFixture(window: UptimeDto["window"]): UptimeDto {
  return {
    monitorId: "mon_1",
    window,
    status: window === "24h" ? "ok" : "no_data",
    percentage: window === "24h" ? 98.5 : null,
    eligibleChecks: window === "24h" ? 200 : 0,
    healthyChecks: window === "24h" ? 197 : 0,
    source: "raw",
  };
}

const INCIDENT: MonitorIncidentDto = {
  id: "inc_1",
  monitorId: "mon_1",
  status: "open",
  openedAt: "2026-09-06T10:00:00.000Z",
  firstFailureAt: "2026-09-06T09:58:00.000Z",
  resolvedAt: null,
  triggerCheckId: null,
  recoveryCheckId: null,
  openReasonCode: "unexpected_status",
  outageDurationMs: null,
  resolutionReason: null,
  createdAt: "2026-09-06T10:00:00.000Z",
  updatedAt: "2026-09-06T10:00:00.000Z",
};

const TARGETS: NotificationTargetDto[] = [
  { id: "tgt_1", name: "Ops", email: "ops@example.com", enabled: true, isDefault: true, createdAt: "", updatedAt: "" },
  { id: "tgt_2", name: "Escalation", email: "esc@example.com", enabled: true, isDefault: false, createdAt: "", updatedAt: "" },
];

// Anchored to the chart range the 30 checks span (newest now-5m … oldest now-150m).
const T0 = Date.now();
function iso(minutesAgo: number): string {
  return new Date(T0 - minutesAgo * 60_000).toISOString();
}

const MAINTENANCE_WINDOWS: MaintenanceWindowDto[] = [
  {
    id: "mw_active",
    title: "Routine deploy",
    description: null,
    scopeType: "global",
    scopeId: null,
    startsAt: iso(70),
    endsAt: iso(40),
    createdBy: null,
    createdAt: iso(200),
    updatedAt: iso(200),
    cancelledAt: null,
  },
  {
    id: "mw_cancelled",
    title: "Cancelled window",
    description: null,
    scopeType: "global",
    scopeId: null,
    startsAt: iso(120),
    endsAt: iso(90),
    createdBy: null,
    createdAt: iso(200),
    updatedAt: iso(100),
    cancelledAt: iso(100),
  },
  {
    id: "mw_other_monitor",
    title: "Someone else",
    description: null,
    scopeType: "monitor",
    scopeId: "mon_other",
    startsAt: iso(100),
    endsAt: iso(10),
    createdBy: null,
    createdAt: iso(200),
    updatedAt: iso(200),
    cancelledAt: null,
  },
];

type ApiHandler = (call: { method: string; url: string; body: unknown }) => Response | null;

function envelope(data: unknown, extra: Record<string, unknown> = {}, status = 200) {
  return new Response(JSON.stringify({ data, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function detailApi(extraHandlers: ApiHandler[] = [], monitor: MonitorDto = monitorFixture()) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  // The mapping set is stateful so invalidation-refetches reflect PUTs.
  let mappings: string[] = ["tgt_1"];
  const base: ApiHandler[] = [
    ({ method, url }) => (method === "GET" && url === "/api/monitors/mon_1" ? envelope(monitor) : null),
    ({ method, url }) => {
      const match = method === "GET" && url.startsWith("/api/monitors/mon_1/uptime?window=");
      if (!match) return null;
      const window = url.split("window=")[1] as UptimeDto["window"];
      return envelope(uptimeFixture(window));
    },
    ({ method, url }) => {
      const match = method === "GET" && url.startsWith("/api/monitors/mon_1/checks?");
      if (!match) return null;
      const params = new URLSearchParams(url.split("?")[1]);
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit") ?? 50);
      const items = Array.from({ length: TOTAL_CHECKS }, (_, i) => checkFixture(i)).slice(offset, offset + limit);
      return envelope(items, { pagination: { total: TOTAL_CHECKS, limit, offset } });
    },
    ({ method, url }) =>
      method === "GET" && url === "/api/monitors/mon_1/incidents?limit=50"
        ? envelope([INCIDENT], { pagination: { total: 1, limit: 50, offset: 0 } })
        : null,
    ({ method, url }) => (method === "GET" && url === "/api/maintenance" ? envelope(MAINTENANCE_WINDOWS) : null),
    ({ method, url }) => (method === "GET" && url === "/api/notification-targets" ? envelope(TARGETS) : null),
    ({ method, url, body }) => {
      if (url !== "/api/monitors/mon_1/notification-targets") return null;
      if (method === "GET") return envelope(mappings);
      if (method === "PUT") {
        mappings = (body as { targetIds: string[] })?.targetIds ?? mappings;
        return envelope(mappings);
      }
      return null;
    },
    ({ method, url }) => (method === "GET" && url === "/api/clients" ? envelope([]) : null),
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    for (const handler of [...base, ...extraHandlers]) {
      const response = handler({ method, url, body });
      if (response !== null) return response;
    }
    throw new Error(`unexpected API call: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function renderDetail(monitorId = "mon_1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/monitors/${monitorId}`]}>
        {/* The page reads :id via useParams — it must mount inside a Route. */}
        <Routes>
          <Route path="monitors/:id" element={<MonitorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MonitorDetailPage (PRD §27.5)", () => {
  it("renders the config summary, status, and all four uptime windows", async () => {
    detailApi();
    renderDetail();

    expect(await screen.findByRole("heading", { name: "Alpha Site" })).toBeInTheDocument();
    expect(screen.getByText("UP")).toBeInTheDocument();
    expect(screen.getByText("https://alpha.example.com/health")).toBeInTheDocument();
    expect(screen.getByText("300s")).toBeInTheDocument();
    expect(screen.getByText("3/2")).toBeInTheDocument(); // fail/rec thresholds

    // 24h ok with the exact percentage; the rest explicitly "No data".
    expect(await screen.findByText("98.50%")).toBeInTheDocument();
    expect(screen.getAllByText("No data")).toHaveLength(3);
  });

  it("renders the seven-column checks table with manual and maintenance flags, paginated", async () => {
    detailApi();
    renderDetail();

    const table = await screen.findByRole("table");
    for (const header of ["Time", "Result", "HTTP", "Response", "Reason", "Trigger", "Maintenance"]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    expect(within(table).getByText("MANUAL")).toBeInTheDocument();
    expect(within(table).getAllByText("Excluded")).toHaveLength(6);
    expect(within(table).getByText("FAIL")).toBeInTheDocument();
    expect(within(table).getByText("unexpected_status")).toBeInTheDocument();

    // Page 1 of 25 total 30 → Next reveals the remaining 5.
    expect(screen.getByText(/25 of 30 checks/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/5 of 30 checks/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText(/25 of 30 checks/)).toBeInTheDocument();
  });

  it("overlays the active maintenance window on the chart, labeled — cancelled/foreign scopes excluded", async () => {
    detailApi();
    renderDetail();

    expect(await screen.findByText("Response time (ms)")).toBeInTheDocument();
    const label = await screen.findByText("Maintenance: Routine deploy");
    expect(label).toBeInTheDocument();
    // Legend makes the overlay meaning explicit beyond color.
    expect(screen.getByText(/Shaded, labeled regions are maintenance windows/)).toBeInTheDocument();
    expect(screen.queryByText(/Cancelled window/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Someone else/)).not.toBeInTheDocument();
  });

  it("lists monitor incidents linking to the stable /incidents/:id deep link", async () => {
    detailApi();
    renderDetail();

    const link = await screen.findByRole("link", { name: "2026-09-06 09:00" });
    expect(link).toHaveAttribute("href", "/incidents/inc_1");
    expect(screen.getByText("OPEN")).toBeInTheDocument();
  });

  it("toggling a notification target PUTs the full replacement mapping set", async () => {
    const calls = detailApi();
    renderDetail();

    const escalation = await screen.findByLabelText(/Escalation/);
    expect(escalation).not.toBeChecked();
    fireEvent.click(escalation);

    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect(put?.body).toEqual({ targetIds: ["tgt_1", "tgt_2"] });
    });
    // The refetch after invalidation reflects the new mapping set; the full
    // page render makes this slower than the default 1s waitFor window.
    await waitFor(() => expect(escalation).toBeChecked(), { timeout: 3000 });
    expect(screen.getByLabelText(/Ops/)).toBeChecked();
  });

  it("run check now POSTs to #14 and surfaces the queued receipt", async () => {
    const calls = detailApi([
      ({ method, url }) =>
        method === "POST" && url === "/api/monitors/mon_1/check"
          ? envelope({ checkId: "mon_1:manual:1", status: "queued" }, {}, 202)
          : null,
    ]);
    renderDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Run check now" }));
    await waitFor(() => expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/check"))).toBeTruthy());
    expect(await screen.findByText(/Manual check queued/)).toBeInTheDocument();
  });

  it("disables run-now for a paused monitor — the API would 409 (review)", async () => {
    detailApi([], monitorFixture({ enabled: false, state: { status: "paused", lastCheckedAt: null, lastStatusCode: null, lastResponseTimeMs: null, lastReasonCode: null } }));
    renderDetail();

    expect(await screen.findByText("PAUSED")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run check now" })).toBeDisabled();
  });

  it("unchecking a target PUTs the mapping set without it (review)", async () => {
    const calls = detailApi();
    renderDetail();

    const ops = await screen.findByLabelText(/Ops/);
    expect(ops).toBeChecked();
    fireEvent.click(ops);
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ targetIds: [] }));
    await waitFor(() => expect(ops).not.toBeChecked(), { timeout: 3000 });
  });

  it("renders a not-found card for an unknown monitor (deep-link safety)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { category: "not_found", message: "monitor not found", requestId: "req_1", details: null } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    renderDetail("mon_nope");
    expect(await screen.findByText("Monitor not found")).toBeInTheDocument();
    expect(screen.getByText(/req_1/)).toBeInTheDocument();
  });
});
