/**
 * The §27.2 nav sections (issues #21–#23; Overview is the real #22 dashboard,
 * Monitors the real #23 page). Real content lands in #24–#27; the titles
 * below are the canonical labels.
 */
import { PlaceholderPage } from "./placeholder-page";
import { MonitorsPage } from "./monitors-page";

export { MonitorsPage };

export function ClientsPage() {
  return <PlaceholderPage title="Clients" description="Group monitors by Morabeza client or site." />;
}

export function IncidentsPage() {
  return <PlaceholderPage title="Incidents" description="Outage history with open incidents first." />;
}

export function MaintenancePage() {
  return <PlaceholderPage title="Maintenance" description="Planned windows that exclude checks from alerting and uptime." />;
}

export function NotificationsPage() {
  return <PlaceholderPage title="Notifications" description="Alert recipients and the delivery log." />;
}

export function ImportExportPage() {
  return <PlaceholderPage title="Import / Export" description="Bulk JSON import and export of monitor configuration." />;
}

export function SystemPage() {
  return <PlaceholderPage title="System" description="Heartbeats, dead letters, and operator settings." />;
}
