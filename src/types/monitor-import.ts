/**
 * Mirror of the worker's bulk import result (worker/services/monitor-import.ts,
 * issue #27; PRD §25). Deliberate two-tsconfig duplication; the
 * api-monitors-import test contract pins the shape.
 */

export interface ImportRowError {
  path: string;
  message: string;
}

export interface ImportRowResult {
  index: number;
  status: "created" | "duplicate" | "failed";
  name: string | null;
  monitorId?: string;
  existingMonitorId?: string;
  errors?: ImportRowError[];
}

export interface ImportResultDto {
  summary: { total: number; created: number; duplicates: number; failed: number };
  results: ImportRowResult[];
}

/** One canonical §25.1 export row (client referenced by name). */
export interface ExportMonitorRow {
  client: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  requestBody: string | null;
  intervalSeconds: number;
  expectedStatusCodes: number[];
  bodyContains: string | null;
  bodyNotContains: string | null;
  maxResponseTimeMs: number | null;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  cacheBust: boolean;
  tags: string[] | null;
}
