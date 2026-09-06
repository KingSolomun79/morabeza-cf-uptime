/**
 * @vitest-environment jsdom
 *
 * Issue #27 — Import/Export page (PRD §25, §27.2): paste/upload import with
 * per-row outcomes, server-envelope rejection of malformed JSON, and the
 * export download.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportExportPage } from "../../src/pages/import-export-page";

type ApiHandler = (call: { method: string; url: string; body: unknown }) => Response | null;

function envelope(data: unknown, extra: Record<string, unknown> = {}, status = 200) {
  return new Response(JSON.stringify({ data, ...extra }), { status, headers: { "Content-Type": "application/json" } });
}

const IMPORT_RESULT = {
  summary: { total: 3, created: 1, duplicates: 1, failed: 1 },
  results: [
    { index: 0, status: "created", name: "Homepage", monitorId: "mon_new" },
    { index: 1, status: "duplicate", name: "Homepage Copy", existingMonitorId: "mon_1", errors: [{ path: "url", message: "probable duplicate of monitor mon_1 (same client, url, and method)" }] },
    { index: 2, status: "failed", name: "Bad Row", errors: [{ path: "client", message: 'unknown client "Ghost"' }] },
  ],
};

function pageApi(extraHandlers: ApiHandler[] = []) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ method, url, body });
      // Extra handlers WIN (checked first) so tests can override base routes.
      const handlers: ApiHandler[] = [
        ...extraHandlers,
        ({ method, url }) => (method === "POST" && url === "/api/monitors/import" ? envelope(IMPORT_RESULT, {}, 201) : null),
        ({ method, url }) => (method === "GET" && url === "/api/monitors/export" ? envelope([{ client: "Morabeza", name: "Homepage", url: "https://contabilistas.cv/", method: "GET", headers: null, intervalSeconds: 300, expectedStatusCodes: [200], bodyContains: null, bodyNotContains: null, maxResponseTimeMs: null, timeoutMs: 10000, failureThreshold: 3, recoveryThreshold: 2, cacheBust: false, tags: null }]) : null),
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
        <ImportExportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ImportExportPage (PRD §25, §27.2)", () => {
  it("imports pasted JSON and renders per-row outcomes with index, status, and detail", async () => {
    const calls = pageApi();
    renderPage();

    fireEvent.change(await screen.findByLabelText(/JSON rows/), {
      target: { value: JSON.stringify([{ client: "Morabeza", name: "Homepage" }]) },
    });
    fireEvent.click(screen.getByRole("button", { name: /Validate & import/ }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post?.body).toContain('"client":"Morabeza"');
    });

    const table = await screen.findByRole("table");
    const createdRow = within(table).getByRole("row", { name: /#0/ });
    expect(within(createdRow).getByText("CREATED")).toBeInTheDocument();
    const createdLink = within(createdRow).getByRole("link", { name: "View monitor" });
    expect(createdLink).toHaveAttribute("href", "/monitors/mon_new");

    const dupRow = within(table).getByRole("row", { name: /#1/ });
    expect(within(dupRow).getByText("DUPLICATE")).toBeInTheDocument();
    expect(within(dupRow).getByRole("link", { name: "existing monitor" })).toHaveAttribute("href", "/monitors/mon_1");

    const failedRow = within(table).getByRole("row", { name: /#2/ });
    expect(within(failedRow).getByText("FAILED")).toBeInTheDocument();
    expect(failedRow.textContent).toContain('client: unknown client "Ghost"');
    expect(screen.getByText(/1 created, 1 duplicate, 1 failed of 3/)).toBeInTheDocument();
  });

  it("surfaces the server's §38 envelope for malformed JSON instead of a crash", async () => {
    pageApi([
      ({ method, url }) =>
        method === "POST" && url === "/api/monitors/import"
          ? new Response(
              JSON.stringify({ error: { category: "validation", message: "request body is not valid JSON", requestId: "req_1", details: null } }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            )
          : null,
    ]);
    renderPage();

    fireEvent.change(await screen.findByLabelText(/JSON rows/), { target: { value: "{not json" } });
    fireEvent.click(screen.getByRole("button", { name: /Validate & import/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Import rejected.*validation/);
    expect(screen.getByText(/req_1/)).toBeInTheDocument();
  });

  it("blocks an empty submit client-side without calling the API", async () => {
    const calls = pageApi();
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /Validate & import/ }));
    expect(await screen.findByText(/Paste or upload a JSON file first/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("loads an uploaded file into the textarea", async () => {
    pageApi();
    renderPage();

    const file = new File([JSON.stringify([{ client: "Morabeza", name: "From File" }])], "monitors.json", { type: "application/json" });
    const input = await screen.findByLabelText(/Upload a \.json file/);
    fireEvent.change(input, { target: { files: [file] } });

    // toHaveValue is string-only for textareas — assert the value property.
    const textarea = await waitFor(() => {
      const element = screen.getByLabelText(/JSON rows/) as HTMLTextAreaElement;
      expect(element.value).toContain("From File");
      return element;
    });
    expect(textarea.value).toContain("From File");
    expect(screen.getByText(/Loaded monitors\.json\./)).toBeInTheDocument();
  });

  it("export downloads the JSON via a blob URL", async () => {
    const calls = pageApi();
    const createdObjectUrls: string[] = [];
    const anchorClicks: string[] = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => {
        const fake = `blob:fake-${createdObjectUrls.length}`;
        createdObjectUrls.push(fake);
        return fake;
      }),
      revokeObjectURL: vi.fn(),
    });
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      anchorClicks.push(this.download);
    };
    afterEach(() => {
      HTMLAnchorElement.prototype.click = originalClick;
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Download JSON/ }));

    await waitFor(() => expect(createdObjectUrls).toHaveLength(1));
    expect(anchorClicks[0]).toMatch(/^morabeza-monitors-\d{4}-\d{2}-\d{2}\.json$/);
    expect(calls.find((call) => call.method === "GET" && call.url === "/api/monitors/export")).toBeTruthy();
    expect(await screen.findByRole("status")).toHaveTextContent(/Exported 1 monitor config row/);
  });
});
