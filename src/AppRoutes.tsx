/**
 * Route table (issues #21–#22; PRD §27.2): the shell layout wraps the nav
 * sections; Overview is the real #22 dashboard, the rest are placeholders
 * until their page slices land. /monitors/:id exists so #22's table rows
 * (and #17 email deep links) resolve — content lands in #24. Exported
 * separately from App so tests can drive specific paths via MemoryRouter.
 */
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

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="monitors" element={<MonitorsPage />} />
        <Route path="monitors/:id" element={<PlaceholderPage title="Monitor detail" description="Response-time chart, check history, incidents, and uptime windows arrive with issue #24." />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="incidents" element={<IncidentsPage />} />
        <Route path="maintenance" element={<MaintenancePage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="import-export" element={<ImportExportPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
