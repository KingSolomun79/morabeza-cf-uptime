/**
 * Overview table filtering + pagination (issue #22; PRD §27.3).
 * Pure functions so the filter combinations are unit-testable without DOM.
 */

export interface MonitorRowLike {
  clientId: string;
  clientName: string;
  name: string;
  status: string;
  inMaintenance: boolean;
}

export interface OverviewFilter {
  /** null / "" = all clients. */
  clientId: string | null;
  /**
   * null / "" = all statuses. The sentinel "maintenance" selects monitors
   * currently inside an active window (the display-level fifth state).
   */
  status: string | null;
  query: string;
}

export const OVERVIEW_PAGE_SIZE = 10;

export function filterMonitorRows<T extends MonitorRowLike>(rows: T[], filter: OverviewFilter): T[] {
  const query = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.clientId && row.clientId !== filter.clientId) return false;
    if (filter.status === "maintenance") {
      if (!row.inMaintenance) return false;
    } else if (filter.status && row.status !== filter.status) {
      return false;
    }
    if (query) {
      const haystack = `${row.name} ${row.clientName}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export interface Page<T> {
  rows: T[];
  total: number;
  pageCount: number;
  page: number;
}

export function paginate<T>(rows: T[], page: number, pageSize: number = OVERVIEW_PAGE_SIZE): Page<T> {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), total: rows.length, pageCount, page: safePage };
}

/** Distinct clients present in the rows, for the filter dropdown. */
export function distinctClients<T extends { clientId: string; clientName: string }>(rows: T[]): Array<{ id: string; name: string }> {
  const byId = new Map<string, string>();
  for (const row of rows) {
    if (!byId.has(row.clientId)) byId.set(row.clientId, row.clientName);
  }
  return Array.from(byId, ([id, name]) => ({ id, name }));
}
