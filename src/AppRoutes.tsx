/**
 * Route table (issues #21–#24; PRD §27.2): the shell layout wraps the nav
 * sections; Overview is the real #22 dashboard, Monitors the real #23 page,
 * and /monitors/:id the real #24 detail (the #17 email deep link — the route
 * shape must stay stable). /incidents/:id resolves the incident deep link;
 * its page content lands in #25. Exported separately from App so tests can
 * drive specific paths via MemoryRouter.
 */
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/app-shell";
import { OverviewPage } from "./pages/overview";
import { MonitorDetailPage } from "./pages/monitor-detail-page";
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

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="monitors" element={<MonitorsPage />} />
        <Route path="monitors/:id" element={<MonitorDetailPage />} />
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
