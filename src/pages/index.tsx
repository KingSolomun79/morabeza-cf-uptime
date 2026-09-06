/**
 * The eight §27.2 nav sections as placeholder routes (issue #21). Real
 * content lands in #22–#27; the titles below are the canonical labels.
 */
import { PlaceholderPage } from "./placeholder-page";

export function OverviewPage() {
  return <PlaceholderPage title="Overview" description="Fleet status, counts, and response-time trend at a glance." />;
}

export function MonitorsPage() {
  return <PlaceholderPage title="Monitors" description="Create, edit, pause, and archive monitored endpoints." />;
}

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
