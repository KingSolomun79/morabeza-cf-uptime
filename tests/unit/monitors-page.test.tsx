/**
 * @vitest-environment jsdom
 *
 * Issue #23 — Monitors page (PRD §27.4): list rendering with badges,
 * filters, the archive confirm guard (no hard delete), run-now/pause
 * actions against mocked API calls, duplicate/edit prefill, and the
 * §10.1 POST warning. fetch is mocked at the envelope level.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MonitorsPage } from "../../src/pages/monitors-page";
import type { ClientDto, MonitorDto } from "../../src/types/monitor";

function client(id: string, name: string): ClientDto {
  return { id, name, slug: id, active: true, notes: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", archivedAt: null };
}

function monitor(patch: Partial<MonitorDto>): MonitorDto {
  return {
    id: "mon_1",
    clientId: "cli_a",
    name: "Alpha Site",
    url: "https://alpha.example.com/health",
    method: "GET",
    headers: null,
    requestBody: null,
    expectedStatusCodes: [200],
    bodyContains: null,
    bodyNotContains: null,
    maxResponseTimeMs: null,
    intervalSeconds: 300,
    timeoutMs: 10000,
    failureThreshold: 3,
    recoveryThreshold: 2,
    cacheBust: false,
    enabled: true,
    tags: null,
    nextCheckAt: "2026-09-06T12:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    state: { status: "up", lastCheckedAt: new Date(Date.now() - 5 * 60_000).toISOString(), lastStatusCode: 200, lastResponseTimeMs: 120, lastReasonCode: null },
    ...patch,
  };
}

const FIXTURE_MONITORS: MonitorDto[] = [
  monitor({}),
  monitor({
    id: "mon_2",
    clientId: "cli_b",
    name: "Beta Portal",
    url: "https://beta.example.com/",
    intervalSeconds: 120,
    enabled: false,
    state: { status: "paused", lastCheckedAt: null, lastStatusCode: null, lastResponseTimeMs: null, lastReasonCode: null },
  }),
];

const FIXTURE_CLIENTS: ClientDto[] = [client("cli_a", "Alpha"), client("cli_b", "Beta")];

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

type ApiHandler = (call: { method: string; url: string; body: unknown }) => Response | null;

/**
 * Minimal envelope router: handlers are checked in order; the last one is a
 * catch-all that fails the test loudly so unexpected requests are visible.
 */
function mockApi(handlers: ApiHandler[]) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    for (const handler of handlers) {
      const response = handler({ method, url, body });
      if (response !== null) return response;
    }
    throw new Error(`unexpected API call: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function envelope(data: unknown, extra: Record<string, unknown> = {}, status = 200) {
  return new Response(JSON.stringify({ data, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MonitorsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function standardApi(extraHandlers: ApiHandler[]) {
  return mockApi([
    ({ method, url }) => (method === "GET" && url.startsWith("/api/monitors?includeArchived=false") ? envelope(FIXTURE_MONITORS) : null),
    ({ method, url }) => (method === "GET" && url === "/api/clients" ? envelope(FIXTURE_CLIENTS) : null),
    ...extraHandlers,
  ]);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MonitorsPage list (PRD §27.4)", () => {
  it("renders rows with status badges, interval, last check, and detail links", async () => {
    standardApi([]);
    renderPage();

    expect(await screen.findByText("Alpha Site")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("UP")).toBeInTheDocument();
    expect(within(table).getByText("PAUSED")).toBeInTheDocument();
    expect(within(table).getByText("300s")).toBeInTheDocument();
    expect(within(table).getByText("120s")).toBeInTheDocument();
    expect(within(table).getByText("5m ago")).toBeInTheDocument();
    const link = within(table).getByRole("link", { name: "Alpha Site" });
    expect(link).toHaveAttribute("href", "/monitors/mon_1");
  });

  it("filters by status and free-text search (name/url/client)", async () => {
    standardApi([]);
    renderPage();
    await screen.findByText("Alpha Site");

    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "paused" } });
    const table = screen.getByRole("table");
    expect(within(table).queryByText("Alpha Site")).not.toBeInTheDocument();
    expect(within(table).getByText("Beta Portal")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Search monitors"), { target: { value: "beta.example" } });
    expect(within(screen.getByRole("table")).getByText("Beta Portal")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByText("Alpha Site")).not.toBeInTheDocument();
  });

  it("shows the empty state when the fleet is empty", async () => {
    mockApi([
      ({ method, url }) => (method === "GET" && url.startsWith("/api/monitors") ? envelope([]) : null),
      ({ method, url }) => (method === "GET" && url === "/api/clients" ? envelope([]) : null),
    ]);
    renderPage();
    expect(await screen.findByText("No monitors yet")).toBeInTheDocument();
  });
});

describe("MonitorsPage actions", () => {
  it("guards archive behind a confirm step and only DELETEs on confirmation", async () => {
    const calls = standardApi([
      ({ method, url }) =>
        method === "DELETE" && url === "/api/monitors/mon_1"
          ? envelope(monitor({ archivedAt: "2026-09-06T12:00:00.000Z", enabled: false }))
          : null,
    ]);
    renderPage();
    const table = await screen.findByRole("table");
    const row = within(table).getByRole("row", { name: /Alpha Site/ });

    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    const confirm = await within(row).findByRole("button", { name: "Confirm archive" });
    expect(within(row).getByRole("button", { name: "Keep" })).toBeInTheDocument();

    fireEvent.click(confirm);
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1));
    expect(await screen.findByText(/archived\. Its history is preserved/)).toBeInTheDocument();
  });

  it("dismissing the confirm step cancels the archive", async () => {
    const calls = standardApi([]);
    renderPage();
    const row = within(await screen.findByRole("table")).getByRole("row", { name: /Alpha Site/ });
    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
    fireEvent.click(within(row).getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("button", { name: "Confirm archive" })).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  it("run check now POSTs to the #14 endpoint and surfaces the queued receipt", async () => {
    const calls = standardApi([
      ({ method, url }) =>
        method === "POST" && url === "/api/monitors/mon_1/check"
          ? envelope({ checkId: "mon_1:manual:1", status: "queued" }, {}, 202)
          : null,
    ]);
    renderPage();
    const row = within(await screen.findByRole("table")).getByRole("row", { name: /Alpha Site/ });
    fireEvent.click(within(row).getByRole("button", { name: "Run now" }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/check"))).toBeTruthy(),
    );
    expect(await screen.findByText(/Manual check queued for "Alpha Site"/)).toBeInTheDocument();
    // Paused rows never offer manual checks (the API would 409).
    const pausedRow = within(screen.getByRole("table")).getByRole("row", { name: /Beta Portal/ });
    expect(within(pausedRow).getByRole("button", { name: "Run now" })).toBeDisabled();
  });

  it("pause PATCHes enabled:false with §23 semantics in the notice", async () => {
    const calls = standardApi([
      ({ method, url }) =>
        method === "PATCH" && url === "/api/monitors/mon_1"
          ? envelope(monitor({ enabled: false, state: { status: "paused", lastCheckedAt: null, lastStatusCode: null, lastResponseTimeMs: null, lastReasonCode: null } }))
          : null,
    ]);
    renderPage();
    const row = within(await screen.findByRole("table")).getByRole("row", { name: /Alpha Site/ });
    fireEvent.click(within(row).getByRole("button", { name: "Pause" }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === "PATCH");
      expect(patch?.body).toEqual({ enabled: false });
    });
    expect(await screen.findByText(/paused — checks stop and the state resets to UNKNOWN/)).toBeInTheDocument();
  });
});

describe("MonitorsPage form (PRD §22 + §10.1)", () => {
  async function openCreateForm() {
    standardApi([]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New monitor" }));
    await screen.findByLabelText("Monitor form");
  }

  it("renders inline field errors from the shared §22 validation without calling the API", async () => {
    const calls = standardApi([]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New monitor" }));

    fireEvent.click(screen.getByRole("button", { name: "Create monitor" }));
    expect(await screen.findByText("client is required")).toBeInTheDocument();
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("shows the §10.1 POST warning only for POST and reveals the request-body field", async () => {
    await openCreateForm();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "POST" } });
    const warning = screen.getByRole("note");
    expect(warning).toHaveTextContent(/may be executed more than once/);
    expect(screen.getByLabelText("Request body (POST only)")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "GET" } });
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Request body (POST only)")).not.toBeInTheDocument();
  });

  it("rejects a sensitive header name inline before any request is made", async () => {
    const calls = standardApi([]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New monitor" }));

    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "cli_a" } });
    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: "Alpha Copy" } });
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: "https://alpha.example.com/health" } });
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "Authorization" } });
    fireEvent.change(screen.getByLabelText("Header value"), { target: { value: "Bearer x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create monitor" }));

    expect(await screen.findByText(/security-sensitive header "Authorization"/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("creates a monitor end-to-end and surfaces the duplicate-probability warning sibling", async () => {
    const calls = standardApi([
      ({ method }) =>
        method === "POST"
          ? envelope(monitor({}), { warning: "probable duplicate of monitor mon_1 (same client, url, and method)" }, 201)
          : null,
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New monitor" }));

    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "cli_a" } });
    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: "Alpha Copy" } });
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: "https://alpha.example.com/health" } });
    fireEvent.click(screen.getByRole("button", { name: "Create monitor" }));

    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    const posted = calls.find((call) => call.method === "POST");
    expect(posted?.body).toMatchObject({ clientId: "cli_a", name: "Alpha Copy", method: "GET", intervalSeconds: 300 });
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/probable duplicate of monitor mon_1/);
  });

  it("duplicate prefills a valid create form with the (copy) suffix", async () => {
    standardApi([]);
    renderPage();
    const row = within(await screen.findByRole("table")).getByRole("row", { name: /Alpha Site/ });
    fireEvent.click(within(row).getByRole("button", { name: "Duplicate" }));

    const name = await screen.findByLabelText(/^Name$/);
    expect(name).toHaveValue("Alpha Site (copy)");
    expect(screen.getByLabelText(/^URL/)).toHaveValue("https://alpha.example.com/health");
    expect(screen.getByLabelText("Interval")).toHaveValue("300");
  });

  it("edit prefills the form and PATCHes the full config on save", async () => {
    const calls = standardApi([
      ({ method, url }) => (method === "PATCH" && url === "/api/monitors/mon_1" ? envelope(monitor({ name: "Alpha Renamed" })) : null),
    ]);
    renderPage();
    const row = within(await screen.findByRole("table")).getByRole("row", { name: /Alpha Site/ });
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));

    const name = await screen.findByLabelText(/^Name$/);
    expect(name).toHaveValue("Alpha Site");
    fireEvent.change(name, { target: { value: "Alpha Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1));
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.body).toMatchObject({ name: "Alpha Renamed", clientId: "cli_a" });
    expect(patch?.body).not.toHaveProperty("enabled");
    expect(await screen.findByText(/updated\./)).toBeInTheDocument();
  });

  it("archived rows are read-only (no action buttons)", async () => {
    mockApi([
      ({ method, url }) =>
        method === "GET" && url.startsWith("/api/monitors")
          ? envelope([monitor({ archivedAt: "2026-09-05T00:00:00.000Z", enabled: false })])
          : null,
      ({ method, url }) => (method === "GET" && url === "/api/clients" ? envelope(FIXTURE_CLIENTS) : null),
    ]);
    renderPage();
    expect(await screen.findByText("ARCHIVED")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });
});
