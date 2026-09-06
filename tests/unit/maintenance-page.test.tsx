/**
 * @vitest-environment jsdom
 *
 * Issue #25 — Maintenance page (PRD §14, §27.8): lifecycle sections,
 * dependent scope picker, UTC persistence of Cape_Verde wall inputs,
 * client+server range gate, and the cancel confirm flow.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MaintenancePage } from "../../src/pages/maintenance-page";
import { utcToWallInput, wallInputToUtcIso } from "../../src/lib/datetime-local";
import type { MaintenanceWindowDto } from "../../src/types/monitor-detail";

const T0 = Date.now();
function iso(offsetMinutes: number): string {
  return new Date(T0 + offsetMinutes * 60_000).toISOString();
}

function windowFixture(patch: Partial<MaintenanceWindowDto>): MaintenanceWindowDto {
  return {
    id: "mw_1",
    title: "Deploy",
    description: null,
    scopeType: "global",
    scopeId: null,
    startsAt: iso(-60),
    endsAt: iso(60),
    createdBy: null,
    createdAt: iso(-120),
    updatedAt: iso(-120),
    cancelledAt: null,
    ...patch,
  };
}

const WINDOWS: MaintenanceWindowDto[] = [
  windowFixture({ id: "mw_active", title: "Active window" }),
  windowFixture({ id: "mw_upcoming", title: "Upcoming window", startsAt: iso(120), endsAt: iso(240) }),
  windowFixture({ id: "mw_past", title: "Past window", startsAt: iso(-300), endsAt: iso(-240) }),
  windowFixture({ id: "mw_cancelled", title: "Cancelled window", startsAt: iso(120), endsAt: iso(240), cancelledAt: iso(0) }),
];

type ApiHandler = (call: { method: string; url: string; body: unknown }) => Response | null;

function envelope(data: unknown, extra: Record<string, unknown> = {}, status = 200) {
  return new Response(JSON.stringify({ data, ...extra }), { status, headers: { "Content-Type": "application/json" } });
}

function maintenanceApi(extraHandlers: ApiHandler[] = []) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const handlers: ApiHandler[] = [
        ({ method, url }) => (method === "GET" && url === "/api/maintenance" ? envelope(WINDOWS) : null),
        ({ method, url }) => (method === "GET" && url === "/api/clients" ? envelope([{ id: "cli_1", name: "Alpha", slug: "alpha", active: true, notes: null, createdAt: "", updatedAt: "", archivedAt: null }]) : null),
        ({ method, url }) => (method === "GET" && url === "/api/monitors?includeArchived=false" ? envelope([{ id: "mon_1", clientId: "cli_1", name: "Alpha Site", url: "https://a.example.com/", method: "GET", headers: null, requestBody: null, expectedStatusCodes: [200], bodyContains: null, bodyNotContains: null, maxResponseTimeMs: null, intervalSeconds: 300, timeoutMs: 10000, failureThreshold: 3, recoveryThreshold: 2, cacheBust: false, enabled: true, tags: null, nextCheckAt: "", createdAt: "", updatedAt: "", archivedAt: null, state: null }]) : null),
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
        <MaintenancePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openCreateForm() {
  fireEvent.click(await screen.findByRole("button", { name: "New window" }));
  await screen.findByLabelText("Maintenance form");
}

function fillValidTimes(starts: string, ends: string) {
  fireEvent.change(screen.getByLabelText(/Starts at/), { target: { value: starts } });
  fireEvent.change(screen.getByLabelText(/Ends at/), { target: { value: ends } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MaintenancePage sections (§27.8)", () => {
  it("routes windows into Active/Upcoming/Past/Cancelled by lifecycle", async () => {
    maintenanceApi();
    renderPage();

    // The section counts come from the lifecycle classifier, so a correct
    // count per section proves the routing of each fixture window. The count
    // lives in a nested span, so match on the heading's accessible name.
    expect(await screen.findByRole("heading", { name: /Active\s*\(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Upcoming\s*\(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Past\s*\(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Cancelled\s*\(1\)/ })).toBeInTheDocument();
    expect(screen.getByText("Active window")).toBeInTheDocument();
    expect(screen.getByText("Cancelled window")).toBeInTheDocument();
    expect(screen.getAllByText(/never re-activate/).length).toBeGreaterThan(0);
  });
});

describe("MaintenancePage form (§14.2 + UTC persistence)", () => {
  it("creates via POST with ms-precision UTC (Cape_Verde wall 10:00 → 11:00Z)", async () => {
    const calls = maintenanceApi([
      ({ method }) => (method === "POST" ? envelope(windowFixture({}), {}, 201) : null),
    ]);
    renderPage();
    await openCreateForm();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Deploy" } });
    fillValidTimes("2026-09-05T10:00", "2026-09-05T12:00");
    fireEvent.click(screen.getByRole("button", { name: "Create window" }));

    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      title: "Deploy",
      description: null,
      scopeType: "global",
      scopeId: null,
      startsAt: "2026-09-05T11:00:00.000Z",
      endsAt: "2026-09-05T13:00:00.000Z",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/created for 2026-09-05 10:00/);
  });

  it("blocks ends ≤ starts inline without calling the API", async () => {
    const calls = maintenanceApi([]);
    renderPage();
    await openCreateForm();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Bad range" } });
    fillValidTimes("2026-09-05T12:00", "2026-09-05T11:00");
    fireEvent.click(screen.getByRole("button", { name: "Create window" }));

    expect(await screen.findByText(/after startsAt/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("shows the scopeId picker only for non-global scopes and enforces a target", async () => {
    const calls = maintenanceApi([
      ({ method }) => (method === "POST" ? envelope(windowFixture({}), {}, 201) : null),
    ]);
    renderPage();
    await openCreateForm();

    expect(screen.queryByLabelText("Client")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "client" } });
    const target = screen.getByLabelText("Client");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Client window" } });
    fillValidTimes("2026-09-05T10:00", "2026-09-05T12:00");

    // No target selected → §14.2 error, no POST.
    fireEvent.click(screen.getByRole("button", { name: "Create window" }));
    expect(await screen.findByText(/require a scopeId/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

    fireEvent.change(target, { target: { value: "cli_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create window" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ scopeType: "client", scopeId: "cli_1" });
  });

  it("cancels a window only after the confirm step", async () => {
    const calls = maintenanceApi([
      ({ method, url }) => (method === "DELETE" && url === "/api/maintenance/mw_active" ? envelope(windowFixture({ cancelledAt: iso(0) })) : null),
    ]);
    renderPage();
    const row = within(await screen.findByText("Active window").then((el) => el.closest("li")!));

    fireEvent.click(row.getByRole("button", { name: "Cancel window" }));
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    fireEvent.click(row.getByRole("button", { name: "Confirm cancel" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1));
    expect(await screen.findByRole("status")).toHaveTextContent(/never re-activates/);
  });

  it("edit prefills display-zone wall times and PATCHes the identical window (AC edit leg)", async () => {
    const calls = maintenanceApi([
      ({ method, url }) => (method === "PATCH" && url === "/api/maintenance/mw_active" ? envelope(windowFixture({ title: "Renamed" })) : null),
    ]);
    renderPage();
    const row = within(await screen.findByText("Active window").then((el) => el.closest("li")!));
    fireEvent.click(row.getByRole("button", { name: "Edit" }));
    await screen.findByLabelText("Maintenance form");

    // mw_active starts at T0−60min. The prefill must be the Cape_Verde wall
    // representation of that instant; minute-precision walls can't carry the
    // fixture's sub-minute ms, so the round trip is asserted via the same
    // conversion the form uses.
    const originalStartsAt = windowFixture({}).startsAt;
    const expectedWall = utcToWallInput(originalStartsAt);
    expect(screen.getByLabelText(/Starts at/)).toHaveValue(expectedWall);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1));
    expect(calls.find((call) => call.method === "PATCH")?.url).toBe("/api/maintenance/mw_active");
    expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({
      title: "Renamed",
      scopeType: "global",
      scopeId: null,
      startsAt: wallInputToUtcIso(expectedWall),
    });
  });
});
