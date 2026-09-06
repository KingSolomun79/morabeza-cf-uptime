/**
 * The §27.2 nav sections (issues #21–#25; Overview, Monitors, Clients,
 * Incidents, and Maintenance are real pages — see their own modules). Real
 * content lands in #26–#27; the titles below are the canonical labels.
 */
import { PlaceholderPage } from "./placeholder-page";
import { MonitorsPage } from "./monitors-page";

export { MonitorsPage };

export function NotificationsPage() {
  return <PlaceholderPage title="Notifications" description="Alert recipients and the delivery log." />;
}

export function ImportExportPage() {
  return <PlaceholderPage title="Import / Export" description="Bulk JSON import and export of monitor configuration." />;
}

export function SystemPage() {
  return <PlaceholderPage title="System" description="Heartbeats, dead letters, and operator settings." />;
}
