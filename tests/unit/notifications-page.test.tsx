/**
 * @vitest-environment jsdom
 *
 * Issue #26 — Notifications page (PRD §27.9): target CRUD, Send test email
 * (#17 queued action), monitor associations editor, and the delivery log
 * with status/attempts/last_error.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationsPage } from "../../src/pages/notifications-page";

type ApiHandler = (call: { method: string; url: string; body: unknown }) => Response | null;

function envelope(data: unknown, extra: Record<string, unknown> = {}, status = 200) {
  return new Response(JSON.stringify({ data, ...extra }), { status, headers: { "Content-Type": "application/json" } });
}

const TARGETS = [
  { id: "tgt_1", name: "Ops", email: "ops@morabeza.cv", enabled: true, isDefault: true, createdAt: "", updatedAt: "" },
  { id: "tgt_2", name: "Escalation", email: "esc@morabeza.cv", enabled: false, isDefault: false, createdAt: "", updatedAt: "" },
];

const EVENTS = [
  { id: "evt_2", monitorId: "mon_1", incidentId: null, targetId: "tgt_1", targetEmail: "ops@morabeza.cv", type: "down", status: "sent", attempts: 1, lastError: null, createdAt: "2026-09-06T11:30:00.000Z", sentAt: "2026-09-06T11:30:10.000Z" },
  { id: "evt_1", monitorId: null, incidentId: null, targetId: "tgt_1", targetEmail: "ops@morabeza.cv", type: "test", status: "failed", attempts: 3, lastError: "SMTP connection refused", createdAt: "2026-09-06T09:00:00.000Z", sentAt: null },
];

const MONITORS = [
  { id: "mon_1", clientId: "cli_1", name: "Alpha Site", url: "https://a.example.com/", method: "GET", headers: null, requestBody: null, expectedStatusCodes: [200], bodyContains: null, bodyNotContains: null, maxResponseTimeMs: null, intervalSeconds: 300, timeoutMs: 10000, failureThreshold: 3, recoveryThreshold: 2, cacheBust: false, enabled: true, tags: null, nextCheckAt: "", createdAt: "", updatedAt: "", archivedAt: null, state: null },
];

let mappings = ["tgt_1"];

function notificationsApi(extraHandlers: ApiHandler[] = []) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  mappings = ["tgt_1"];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      const handlers: ApiHandler[] = [
        ({ method, url }) => {
          if (url !== "/api/notification-targets") return null;
          if (method === "GET") return envelope(TARGETS);
          if (method === "POST") return envelope({ ...TARGETS[0], ...((body as Record<string, unknown>) ?? {}) }, {}, 201);
          return null;
        },
        ({ method, url }) =>
          method === "GET" && url.startsWith("/api/notification-events?")
            ? envelope(EVENTS, { pagination: { total: EVENTS.length, limit: 25, offset: 0 } })
            : null,
        ({ method, url }) => {
          if (method === "GET" && url === "/api/monitors/mon_1/notification-targets") return envelope(mappings);
          if (method === "PUT" && url === "/api/monitors/mon_1/notification-targets") {
            mappings = (body as { targetIds: string[] })?.targetIds ?? mappings;
            return envelope(mappings);
          }
          return null;
        },
        ({ method, url }) =>
          method === "POST" && url === "/api/notification-targets/tgt_1/test"
            ? envelope({ notificationEventId: "evt_new", queued: true }, {}, 202)
            : null,
        ({ method, url }) => (method === "GET" && url === "/api/monitors?includeArchived=false" ? envelope(MONITORS) : null),
        ({ method, url }) => (method === "GET" && url === "/api/clients" ? envelope([]) : null),
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
        <NotificationsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NotificationsPage (PRD §27.9)", () => {
  it("renders recipients with default/disabled badges and the delivery log", async () => {
    notificationsApi();
    renderPage();

    expect(await screen.findByText("Ops")).toBeInTheDocument();
    expect(screen.getByText("DEFAULT")).toBeInTheDocument();
    expect(screen.getByText("DISABLED")).toBeInTheDocument();

    // Delivery log: newest first, failed row carries attempts + last error.
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).getByText("SENT")).toBeInTheDocument();
    expect(within(rows[2]).getByText("FAILED")).toBeInTheDocument();
    expect(within(rows[2]).getByText("3")).toBeInTheDocument();
    expect(within(rows[2]).getByText("SMTP connection refused")).toBeInTheDocument();
  });

  it("rejects an invalid email inline and POSTs a valid create", async () => {
    const calls = notificationsApi([
      ({ method }) => (method === "POST" ? envelope({ id: "tgt_9" }, {}, 201) : null),
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New target" }));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "On-call" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Create target" }));
    expect(await screen.findByText(/enter a valid email address/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "oncall@morabeza.cv" } });
    fireEvent.click(screen.getByRole("button", { name: "Create target" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ name: "On-call", email: "oncall@morabeza.cv" });
  });

  it("send test email POSTs the #17 endpoint and surfaces the queued event", async () => {
    const calls = notificationsApi();
    renderPage();
    const opsRow = within((await screen.findByText("Ops")).closest("li")!);
    fireEvent.click(opsRow.getByRole("button", { name: /Send test email/ }));

    await waitFor(() => expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/test"))).toBeTruthy());
    expect(await screen.findByRole("status")).toHaveTextContent(/Test email queued to ops@morabeza\.cv/);
    // The disabled target's action is unavailable (server would fail it anyway).
    expect(within(screen.getByText("Escalation").closest("li")!).getByRole("button", { name: /Send test email/ })).toBeDisabled();
  });

  it("guards delete behind a confirm step", async () => {
    const calls = notificationsApi([
      ({ method, url }) => (method === "DELETE" && url === "/api/notification-targets/tgt_2" ? envelope({ id: "tgt_2", deleted: true }) : null),
    ]);
    renderPage();
    const escRow = within((await screen.findByText("Escalation")).closest("li")!);

    fireEvent.click(escRow.getByRole("button", { name: "Delete" }));
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    fireEvent.click(escRow.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1));
  });

  it("associations editor PUTs the full mapping replacement for the selected monitor", async () => {
    const calls = notificationsApi();
    renderPage();

    // The select's options come from the monitors query — wait for the
    // option to exist BEFORE changing, or the value assignment silently no-ops.
    await screen.findByRole("option", { name: "Alpha Site" });
    fireEvent.change(screen.getByLabelText("Monitor"), { target: { value: "mon_1" } });
    // JSX collapses NEWLINE whitespace but preserves the same-line space, so
    // the label is "Escalation (esc@…)" — the ^ anchor excludes the row
    // group's "Actions for Ops" aria-label.
    const escalation = await screen.findByLabelText(/^Escalation \(/);
    expect(escalation).not.toBeChecked();
    expect(screen.getByLabelText(/^Ops \(/)).toBeChecked();
    fireEvent.click(escalation);

    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect(put?.body).toEqual({ targetIds: ["tgt_1", "tgt_2"] });
    });
    await waitFor(() => expect(escalation).toBeChecked(), { timeout: 3000 });
  });
});
