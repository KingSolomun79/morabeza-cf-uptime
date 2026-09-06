/**
 * Route table (issues #21–#24; PRD §27.2): the shell layout wraps the nav
 * sections; Overview is the real #22 dashboard, Monitors the real #23 page,
 * and /monitors/:id the real #24 detail (the #17 email deep link — the route
 * shape must stay stable). /incidents/:id resolves the incident deep link;
 * its page content lands in #25. Exported separately from App so tests can
 * drive specific paths via MemoryRouter.
 */
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/app-shell";
import { OverviewPage } from "./pages/overview";
import { PlaceholderPage } from "./pages/placeholder-page";
import {
  ClientsPage,
  IncidentsPage,
  ImportExportPage,
  MaintenancePage,
  MonitorsPage,
  NotificationsPage,
  SystemPage,
} from "./pages";

// The detail page carries Recharts (~1/3 of the bundle) — load it only when
// a deep link or table row actually needs it.
const MonitorDetailPage = lazy(() =>
  import("./pages/monitor-detail-page").then((m) => ({ default: m.MonitorDetailPage })),
);

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="monitors" element={<MonitorsPage />} />
        <Route
          path="monitors/:id"
          element={
            <Suspense fallback={<div className="space-y-4" aria-busy="true" aria-label="Loading monitor"><div className="h-8 w-64 animate-pulse rounded-md bg-muted" /><div className="h-64 w-full animate-pulse rounded-md bg-muted" /></div>}>
              <MonitorDetailPage />
            </Suspense>
          }
        />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="incidents" element={<IncidentsPage />} />
        <Route path="incidents/:id" element={<PlaceholderPage title="Incident detail" description="The full incident timeline and recovery information arrive with issue #25." />} />
        <Route path="maintenance" element={<MaintenancePage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="import-export" element={<ImportExportPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
