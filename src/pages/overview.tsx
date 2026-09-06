/**
 * Overview dashboard (issue #22; PRD §27.3): stat cards, response-time
 * trend from rollups, heartbeat summary, and the primary monitor table
 * (Client | Monitor | Status | 24h uptime | Last response | Last check |
 * Incident) with client/status/search filters and pagination. Data comes
 * from the single aggregate GET /api/dashboard response.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useState } from "react";
import { AlertTriangle, CircleCheck, CircleX, RefreshCw, ShieldAlert } from "lucide-react";
import { apiRequestEnvelope, UptimeApiError } from "../lib/api";
import { formatRelative, formatTimestamp } from "../lib/time-format";
import type { DashboardDto } from "../types/dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { StatusBadge, isMonitorStatus } from "../components/status-badge";
import { StatCard } from "../components/stat-card";
import { Sparkline } from "../components/sparkline";
import { distinctClients, filterMonitorRows, OVERVIEW_PAGE_SIZE, paginate } from "./overview-filters";

function UptimeCell({ value }: { value: DashboardDto["monitors"][number]["uptime24h"] }) {
  if (value.status === "no_data") return <span className="text-muted-foreground">No data</span>;
  return <span className="font-mono">{value.percentage?.toFixed(2)}%</span>;
}

function LastCheckCell({ at }: { at: string | null }) {
  if (at === null) return <span className="text-muted-foreground">never</span>;
  return (
    <time dateTime={at} title={formatTimestamp(at)}>
      {formatRelative(at)}
    </time>
  );
}

function errorCategory(error: unknown): string {
  return error instanceof UptimeApiError ? error.category : "internal";
}

function errorRequestId(error: unknown): string | null {
  return error instanceof UptimeApiError ? error.requestId : null;
}

export function OverviewPage() {
  const query = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiRequestEnvelope<DashboardDto>("/api/dashboard"),
    refetchInterval: 30_000,
  });

  // The page title renders regardless of query state (route smoke depends
  // on it; the section heading must not flicker away on refetches).

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Overview</h1>
        {query.isSuccess && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium"
            title={query.data.data.heartbeat.status === "ok" ? "All system components fresh" : "A system component missed its heartbeat"}
          >
            {query.data.data.heartbeat.status === "ok" ? (
              <CircleCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
            )}
            {query.data.data.heartbeat.status === "ok" ? "System healthy" : "System degraded"}
          </span>
        )}
      </div>

      {query.isPending && (
        <div className="space-y-4" aria-busy="true" aria-label="Loading overview">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {query.isError && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
              Overview unavailable
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {errorCategory(query.error) === "network"
                ? "The API could not be reached."
                : `The API returned an error (${errorCategory(query.error)}).`}
              {errorRequestId(query.error) ? ` Correlation id: ${errorRequestId(query.error)}` : null}
            </p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {query.isSuccess && <DashboardContent data={query.data.data} />}
    </div>
  );
}

/** Everything below the title: owns the filter + pagination state. */
function DashboardContent({ data: dashboard }: { data: DashboardDto }) {
  const [clientFilter, setClientFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const clients = distinctClients(dashboard.monitors);
  const filtered = filterMonitorRows(dashboard.monitors, {
    clientId: clientFilter || null,
    status: statusFilter || null,
    query: search,
  });
  const paged = paginate(filtered, page);
  const latestTrend = dashboard.trend.length > 0 ? dashboard.trend[dashboard.trend.length - 1] : null;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <StatCard label="Active" value={dashboard.counts.totalActive} />
        <StatCard label="Up" value={dashboard.counts.up} valueClassName="text-emerald-600 dark:text-emerald-400" />
        <StatCard label="Down" value={dashboard.counts.down} valueClassName="text-red-600 dark:text-red-400" />
        <StatCard label="Unknown" value={dashboard.counts.unknown} />
        <StatCard label="Paused" value={dashboard.counts.paused} />
        <StatCard label="Maintenance" value={dashboard.counts.inMaintenance} />
        <StatCard label="Open incidents" value={dashboard.counts.openIncidents} valueClassName={dashboard.counts.openIncidents > 0 ? "text-red-600 dark:text-red-400" : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Response-time trend (§27.3, from rollups) */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Response-time trend (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            {dashboard.trend.length > 1 && latestTrend ? (
              <div className="text-primary">
                <Sparkline points={dashboard.trend.map((point) => point.avgResponseTimeMs)} label="Average response time per hour over the last 24 hours" />
                <p className="mt-2 text-xs text-muted-foreground">
                  Latest hour avg: {latestTrend.avgResponseTimeMs} ms · {dashboard.trend.length} hourly buckets
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No response-time data yet.</p>
            )}
          </CardContent>
        </Card>

        {/* Recent recoveries (§27.3) */}
        <Card>
          <CardHeader>
            <CardTitle>Recent recoveries</CardTitle>
          </CardHeader>
          <CardContent>
            {dashboard.recentRecoveries.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing recovered recently.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {dashboard.recentRecoveries.map((recovery) => (
                  <li key={recovery.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{recovery.monitorName}</span>
                    <span className="shrink-0 text-muted-foreground">
                      <CircleX className="mr-1 inline h-3 w-3" aria-hidden="true" />
                      {formatRelative(recovery.resolvedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Primary table (§27.3) */}
      <Card>
        <CardHeader>
          <CardTitle>Monitors</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {dashboard.monitors.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center">
              <p className="font-medium">No monitors yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Create your first monitor on the <Link to="/monitors" className="underline">Monitors page</Link> to start tracking uptime.
              </p>
            </div>
          ) : (
            <>
              {/* Filters: client + status + text search (§27.3) */}
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="filter-client">Filter by client</label>
                <select
                  id="filter-client"
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={clientFilter}
                  onChange={(event) => { setClientFilter(event.target.value); setPage(1); }}
                >
                  <option value="">All clients</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>{client.name}</option>
                  ))}
                </select>
                <label className="sr-only" htmlFor="filter-status">Filter by status</label>
                <select
                  id="filter-status"
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={statusFilter}
                  onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}
                >
                  <option value="">All statuses</option>
                  <option value="up">Up</option>
                  <option value="down">Down</option>
                  <option value="unknown">Unknown</option>
                  <option value="paused">Paused</option>
                  <option value="maintenance">In maintenance</option>
                </select>
                <label className="sr-only" htmlFor="filter-search">Search monitors</label>
                <Input
                  id="filter-search"
                  type="search"
                  placeholder="Search monitors…"
                  className="max-w-xs"
                  value={search}
                  onChange={(event) => { setSearch(event.target.value); setPage(1); }}
                />
              </div>

              {paged.rows.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No monitors match the current filters.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Monitors with status, 24-hour uptime, last response, last check, and incident state</caption>
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th scope="col" className="py-2 pr-3">Client</th>
                        <th scope="col" className="py-2 pr-3">Monitor</th>
                        <th scope="col" className="py-2 pr-3">Status</th>
                        <th scope="col" className="py-2 pr-3">24h uptime</th>
                        <th scope="col" className="py-2 pr-3">Last response</th>
                        <th scope="col" className="py-2 pr-3">Last check</th>
                        <th scope="col" className="py-2">Incident</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paged.rows.map((row) => (
                        <tr key={row.id} className="border-b last:border-0">
                          <td className="py-2 pr-3">{row.clientName}</td>
                          <td className="py-2 pr-3">
                            <Link to={`/monitors/${row.id}`} className="font-medium underline-offset-2 hover:underline">
                              {row.name}
                            </Link>
                          </td>
                          <td className="py-2 pr-3">
                            <StatusBadge
                              status={
                                row.inMaintenance
                                  ? "maintenance"
                                  : isMonitorStatus(row.status)
                                    ? row.status
                                    : "unknown"
                              }
                            />
                          </td>
                          <td className="py-2 pr-3"><UptimeCell value={row.uptime24h} /></td>
                          <td className="py-2 pr-3 font-mono">
                            {row.lastResponseTimeMs === null ? <span className="text-muted-foreground">—</span> : `${row.lastResponseTimeMs} ms`}
                          </td>
                          <td className="py-2 pr-3"><LastCheckCell at={row.lastCheckedAt} /></td>
                          <td className="py-2">
                            {row.openIncidentId ? (
                              <span className="inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
                                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                                Open
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {filtered.length > OVERVIEW_PAGE_SIZE && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>Showing {paged.rows.length} of {filtered.length}</span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={paged.page <= 1} onClick={() => setPage(paged.page - 1)}>
                      Previous
                    </Button>
                    <Button variant="outline" size="sm" disabled={paged.page >= paged.pageCount} onClick={() => setPage(paged.page + 1)}>
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
