/**
 * Route table (issues #21–#27; PRD §27.2): every nav section is a real
 * page. /monitors/:id and /incidents/:id are the #17 email deep links —
 * their shapes must stay stable. Exported separately from App so tests can
 * drive specific paths via MemoryRouter.
 */
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/app-shell";
import { OverviewPage } from "./pages/overview";
import { ClientsPage, ClientDetailPage } from "./pages/clients-page";
import { IncidentsPage, IncidentDetailPage } from "./pages/incidents-page";
import { MaintenancePage } from "./pages/maintenance-page";
import { NotificationsPage } from "./pages/notifications-page";
import { SystemPage } from "./pages/system-page";
import { MonitorsPage } from "./pages/monitors-page";
import { ImportExportPage } from "./pages/import-export-page";

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
        <Route path="clients/:id" element={<ClientDetailPage />} />
        <Route path="incidents" element={<IncidentsPage />} />
        <Route path="incidents/:id" element={<IncidentDetailPage />} />
        <Route path="maintenance" element={<MaintenancePage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="import-export" element={<ImportExportPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
