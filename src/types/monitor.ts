/**
 * Mirrors of the worker's monitor/client DTOs (worker/repositories/monitors.ts,
 * worker/repositories/clients.ts). Duplicated deliberately: the app and worker
 * tsconfig projects have disjoint lib/type universes, so runtime types are
 * restated here — the api-monitors/api-clients test contracts pin the shapes.
 * Validation logic itself is NOT duplicated: the form imports the worker's
 * shared Zod schemas (issue #23 implementation note).
 */

export interface ClientDto {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface MonitorStateDto {
  status: string;
  lastCheckedAt: string | null;
  lastStatusCode: number | null;
  lastResponseTimeMs: number | null;
  lastReasonCode: string | null;
}

export interface MonitorDto {
  id: string;
  clientId: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  requestBody: string | null;
  expectedStatusCodes: number[];
  bodyContains: string | null;
  bodyNotContains: string | null;
  maxResponseTimeMs: number | null;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  cacheBust: boolean;
  enabled: boolean;
  tags: string[] | null;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  state: MonitorStateDto | null;
}

/** Receipt of POST /api/monitors/:id/check (issue #14; PRD §13). */
export interface ManualCheckReceipt {
  checkId: string;
  status: "queued";
}
