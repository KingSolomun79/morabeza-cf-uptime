/**
 * Monitors list filtering + pagination (issue #23; PRD §27.4).
 * Pure functions so filter combinations are unit-testable without DOM.
 * Reuses the generic `paginate` from overview-filters (same table idiom).
 */
import { paginate } from "./overview-filters";

export interface MonitorListRow {
  clientId: string;
  clientName: string;
  name: string;
  url: string;
  /** Underlying machine state; "unknown" when no state row exists yet. */
  status: string;
  archived: boolean;
}

export interface MonitorListFilter {
  /** null / "" = all clients. */
  clientId: string | null;
  /**
   * null / "" = all statuses. "paused" covers disabled monitors; "archived"
   * only matches when the query includes archived rows.
   */
  status: string | null;
  query: string;
}

export const MONITORS_PAGE_SIZE = 15;

export function filterMonitorList<T extends MonitorListRow>(rows: T[], filter: MonitorListFilter): T[] {
  const query = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.clientId && row.clientId !== filter.clientId) return false;
    if (filter.status && row.status !== filter.status) return false;
    if (query) {
      const haystack = `${row.name} ${row.url} ${row.clientName}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export { paginate };
