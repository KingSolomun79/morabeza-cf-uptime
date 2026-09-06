/**
 * @vitest-environment jsdom
 *
 * Issue #21 — UI foundation tests: StatusBadge a11y vocabulary, the typed
 * API client's §38 envelope mapping, and a route smoke test over all eight
 * nav sections. Uses jsdom (per-file pragma); the rest of the suite stays
 * on the node environment (miniflare/D1 tests must not see DOM globals).
 */
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBadge, MONITOR_STATUSES, type MonitorStatus } from "../../src/components/status-badge";
import { AppRoutes } from "../../src/AppRoutes";
import {
  API_ERROR_CATEGORIES,
  NETWORK_CATEGORY,
  apiRequest,
  UptimeApiError,
} from "../../src/lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// StatusBadge: five canonical statuses, text+icon (never color alone)

describe("StatusBadge (PRD §27)", () => {
  it.each(MONITOR_STATUSES.map((status) => [status] as const))(
    "renders %s with its text label and an icon",
    (status: MonitorStatus) => {
      render(<StatusBadge status={status} />);
      const badge = screen.getByText(status.toUpperCase());
      expect(badge).toBeInTheDocument();
      // Icon is present and hidden from AT (the text is the accessible name).
      const icon = badge.parentElement?.querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute("aria-hidden", "true");
    },
  );

  it("exposes the status as a title for hover/AT context and supports notes", () => {
    const { rerender } = render(<StatusBadge status="up" />);
    expect(screen.getByTitle("UP")).toBeInTheDocument();

    rerender(<StatusBadge status="down" note="since 12:04 UTC" />);
    expect(screen.getByTitle("since 12:04 UTC")).toBeInTheDocument();
    expect(screen.getByText("DOWN")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// API client: §38 envelope mapping

describe("apiRequest typed error mapping (PRD §38)", () => {
  it("unwraps the success envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { id: "mon_1", name: "Homepage" } }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Request-Id": "req_ok" },
        }),
      ),
    );

    const data = await apiRequest<{ id: string; name: string }>("/api/monitors/mon_1");
    expect(data).toEqual({ id: "mon_1", name: "Homepage" });
  });

  it.each(API_ERROR_CATEGORIES.map((category) => [category] as const))(
    "maps the §38 %s category to a typed error with the correlation id",
    async (category) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              error: {
                category,
                message: `message for ${category}`,
                requestId: "req_123",
                details: [{ path: "url", message: "required" }],
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      const error = await apiRequest("/api/whatever").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UptimeApiError);
      const apiError = error as UptimeApiError;
      expect(apiError.category).toBe(category);
      expect(apiError.message).toBe(`message for ${category}`);
      expect(apiError.requestId).toBe("req_123");
      expect(apiError.status).toBe(400);
      expect(apiError.details).toEqual([{ path: "url", message: "required" }]);
    },
  );

  it("falls back to internal for unknown categories and non-JSON error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { category: "mystery" } }), { status: 500 }),
        )
        .mockResolvedValueOnce(new Response("<html>proxy error</html>", { status: 502 })),
    );

    const unknown = (await apiRequest("/x").catch((e: unknown) => e)) as UptimeApiError;
    expect(unknown.category).toBe("internal");

    const nonJson = (await apiRequest("/x").catch((e: unknown) => e)) as UptimeApiError;
    expect(nonJson.category).toBe("internal");
    expect(nonJson.status).toBe(502);
  });

  it("maps fetch failures (offline/DNS) to the client-only network category", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    const error = (await apiRequest("/api/monitors").catch((e: unknown) => e)) as UptimeApiError;
    expect(error.category).toBe(NETWORK_CATEGORY);
    expect(error.requestId).toBeNull();
  });

  it("rejects a malformed success response as internal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    const error = (await apiRequest("/x").catch((e: unknown) => e)) as UptimeApiError;
    expect(error.category).toBe("internal");
  });
});

// ---------------------------------------------------------------------------
// Route smoke: all eight §27.2 sections render without crashing

function renderRoute(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("route smoke test (PRD §27.2)", () => {
  const SECTIONS: Array<[string, string]> = [
    ["/", "Overview"],
    ["/monitors", "Monitors"],
    ["/clients", "Clients"],
    ["/incidents", "Incidents"],
    ["/maintenance", "Maintenance"],
    ["/notifications", "Notifications"],
    ["/import-export", "Import / Export"],
    ["/system", "System"],
  ];

  it.each(SECTIONS)("renders %s at its route", (path, title) => {
    renderRoute(path);
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    // The shell's primary navigation is present with all eight sections.
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeInTheDocument();
  });

  it("renders the full sidebar navigation with eight links", () => {
    renderRoute("/");
    for (const [, title] of SECTIONS) {
      expect(screen.getAllByRole("link", { name: title }).length).toBeGreaterThan(0);
    }
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});
