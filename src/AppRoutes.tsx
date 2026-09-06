/**
 * Route table (issue #21; PRD §27.2): the shell layout wraps the eight
 * nav sections; unknown paths fall back to Overview. Exported separately
 * from App so tests can drive specific paths via MemoryRouter.
 */
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/app-shell";
import {
  ClientsPage,
  IncidentsPage,
  ImportExportPage,
  MaintenancePage,
  MonitorsPage,
  NotificationsPage,
  OverviewPage,
  SystemPage,
} from "./pages";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="monitors" element={<MonitorsPage />} />
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
