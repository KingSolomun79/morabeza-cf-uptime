/**
 * The §27.2 nav sections (issues #21–#26; every section is a real page
 * except Import/Export, which lands with #27).
 */
import { PlaceholderPage } from "./placeholder-page";
import { MonitorsPage } from "./monitors-page";

export { MonitorsPage };

export function ImportExportPage() {
  return <PlaceholderPage title="Import / Export" description="Bulk JSON import and export of monitor configuration." />;
}
