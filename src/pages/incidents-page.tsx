/**
 * Incidents pages (issue #25; PRD §27.7, §24): open-first paginated list,
 * and the incident detail with the full §27.7 field set — monitor, client,
 * first failure, threshold-crossing check, open reason, recovery, duration,
 * and a related-check timeline assembled from #13 data + the #24 checks
 * endpoint. /incidents/:id is the #17 email deep link — stable.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { apiRequest, apiRequestEnvelope, UptimeApiError } from "../lib/api";
import { formatDuration, formatRelative, formatTimestamp } from "../lib/time-format";
import type { ClientDto, MonitorDto } from "../types/monitor";
import type { CheckDto, MonitorIncidentDto } from "../types/monitor-detail";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";

const PAGE_SIZE = 25;

function IncidentStatusBadge({ status }: { status: MonitorIncidentDto["status"] }) {
  const map: Record<MonitorIncidentDto["status"], { label: string; variant: "danger" | "success" | "neutral" }> = {
    open: { label: "OPEN", variant: "danger" },
    resolved: { label: "RESOLVED", variant: "success" },
    closed_admin: { label: "CLOSED", variant: "neutral" },
  };
  // Forward-compat: render unknown future statuses as neutral text.
  const style = map[status] ?? { label: status.toUpperCase(), variant: "neutral" as const };
  return (
    <Badge variant={style.variant} className="font-mono">{style.label}</Badge>
  );
}

function incidentDuration(incident: MonitorIncidentDto): string {
  if (incident.status === "open") return "ongoing";
  if (incident.outageDurationMs !== null) return formatDuration(incident.outageDurationMs);
  return "—";
}

export function IncidentsPage() {
  const [page, setPage] = useState(1);
  const incidentsQuery = useQuery({
    queryKey: ["incidents", page],
    queryFn: () =>
      apiRequestEnvelope<MonitorIncidentDto[]>(`/api/incidents?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`),
    refetchInterval: 30_000,
  });
  const monitorsQuery = useQuery({
    queryKey: ["monitors", false],
    queryFn: () => apiRequest<MonitorDto[]>("/api/monitors?includeArchived=false"),
  });
  const clientsQuery = useQuery({ queryKey: ["clients"], queryFn: () => apiRequest<ClientDto[]>("/api/clients") });

  const monitorById = useMemo(() => {
    const map = new Map<string, MonitorDto>();
    for (const monitor of monitorsQuery.data ?? []) map.set(monitor.id, monitor);
    return map;
  }, [monitorsQuery.data]);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Incidents</h1>

      {incidentsQuery.isPending && (
        <div aria-busy="true" aria-label="Loading incidents"><Skeleton className="h-64 w-full" /></div>
      )}

      {incidentsQuery.isError && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
              Incidents unavailable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void incidentsQuery.refetch()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {incidentsQuery.isSuccess && (
        <Card>
          <CardHeader><CardTitle>History</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {incidentsQuery.data.data.length === 0 ? (
              <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No incidents recorded — the fleet is healthy.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Incidents, open first, then resolved (PRD §27.7)</caption>
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="py-2 pr-3">Status</th>
                      <th scope="col" className="py-2 pr-3">Monitor</th>
                      <th scope="col" className="py-2 pr-3">Client</th>
                      <th scope="col" className="py-2 pr-3">Opened</th>
                      <th scope="col" className="py-2 pr-3">Duration</th>
                      <th scope="col" className="py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {incidentsQuery.data.data.map((incident) => {
                      const monitor = monitorById.get(incident.monitorId);
                      return (
                        <tr key={incident.id} className="border-b last:border-0">
                          <td className="py-2 pr-3"><IncidentStatusBadge status={incident.status} /></td>
                          <td className="py-2 pr-3">
                            <Link to={`/incidents/${incident.id}`} className="underline underline-offset-2">Incident</Link>
                            {" · "}
                            <Link to={`/monitors/${incident.monitorId}`} className="underline-offset-2 hover:underline">
                              {monitor?.name ?? incident.monitorId}
                            </Link>
                          </td>
                          <td className="py-2 pr-3">
                            {monitor ? (clientsQuery.data?.find((client) => client.id === monitor.clientId)?.name ?? monitor.clientId) : "—"}
                          </td>
                          <td className="py-2 pr-3" title={formatTimestamp(incident.openedAt)}>{formatRelative(incident.openedAt)}</td>
                          <td className="py-2 pr-3">{incidentDuration(incident)}</td>
                          <td className="py-2 pr-3 font-mono text-xs">{incident.openReasonCode ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Page {page}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page * PAGE_SIZE >= (incidentsQuery.data.pagination?.total ?? 0)}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Incident detail (§27.7): full field set + related-check timeline. */
export function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const incidentId = id ?? "";

  const incidentQuery = useQuery({
    queryKey: ["incident", incidentId],
    queryFn: () => apiRequest<MonitorIncidentDto>(`/api/incidents/${incidentId}`),
    enabled: incidentId !== "",
  });
  const incident = incidentQuery.data;
  const monitorQuery = useQuery({
    queryKey: ["monitor", incident?.monitorId ?? ""],
    queryFn: () => apiRequest<MonitorDto>(`/api/monitors/${incident?.monitorId}`),
    enabled: !!incident,
  });
  const monitor = monitorQuery.data;
  const clientsQuery = useQuery({
    queryKey: ["clients"],
    queryFn: () => apiRequest<ClientDto[]>("/api/clients"),
    enabled: !!monitor,
  });
  const checksQuery = useQuery({
    queryKey: ["monitor-checks", incident?.monitorId ?? "", "incident-timeline"],
    queryFn: () => apiRequestEnvelope<CheckDto[]>(`/api/monitors/${incident?.monitorId}/checks?limit=200&offset=0`),
    enabled: !!incident,
  });

  const timeline = useMemo(() => {
    if (!incident || !checksQuery.isSuccess) return null;
    const start = Date.parse(incident.firstFailureAt);
    const end = incident.resolvedAt !== null ? Date.parse(incident.resolvedAt) : Number.MAX_SAFE_INTEGER;
    return checksQuery.data.data
      .filter((check) => {
        const at = Date.parse(check.completedAt);
        // Window is [firstFailureAt, resolvedAt); include the threshold-crossing
        // check explicitly in case it predates the persisted sequence anchor.
        return (at >= start && at < end) || check.id === incident.triggerCheckId || check.id === incident.recoveryCheckId;
      })
      .sort((a, b) => (a.completedAt < b.completedAt ? -1 : 1));
  }, [incident, checksQuery.isSuccess, checksQuery.data]);

  if (incidentQuery.isPending) {
    return <div aria-busy="true" aria-label="Loading incident"><Skeleton className="h-64 w-full" /></div>;
  }
  if (incidentQuery.isError) {
    const notFound = incidentQuery.error instanceof UptimeApiError && incidentQuery.error.category === "not_found";
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            {notFound ? "Incident not found" : "Incident unavailable"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={() => void incidentQuery.refetch()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!incident) {
    // Unreachable after the pending/error guards; satisfies narrowing.
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">Incident</h1>
          <IncidentStatusBadge status={incident.status} />
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Monitor</dt>
              <dd>
                {monitor ? (
                  <Link to={`/monitors/${monitor.id}`} className="underline underline-offset-2">{monitor.name}</Link>
                ) : (
                  incident.monitorId
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Client</dt>
              <dd>
                {monitor ? (
                  clientsQuery.data ? (
                    (() => {
                      const client = clientsQuery.data.find((candidate) => candidate.id === monitor.clientId);
                      return client ? (
                        <Link to={`/clients/${client.id}`} className="underline underline-offset-2">{client.name}</Link>
                      ) : (
                        monitor.clientId
                      );
                    })()
                  ) : (
                    monitor.clientId
                  )
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">First failure</dt>
              <dd><time dateTime={incident.firstFailureAt}>{formatTimestamp(incident.firstFailureAt)}</time></dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Opened (threshold crossing)</dt>
              <dd><time dateTime={incident.openedAt}>{formatTimestamp(incident.openedAt)}</time></dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Open reason</dt>
              <dd className="font-mono text-xs">{incident.openReasonCode ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Threshold-crossing check</dt>
              <dd className="font-mono text-xs">{incident.triggerCheckId ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Recovery</dt>
              <dd>
                {incident.resolvedAt === null ? (
                  "not yet recovered"
                ) : (
                  <>
                    <time dateTime={incident.resolvedAt}>{formatTimestamp(incident.resolvedAt)}</time>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {incident.resolutionReason ?? ""}
                      {incident.recoveryCheckId ? ` · ${incident.recoveryCheckId}` : ""}
                    </span>
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Duration</dt>
              <dd>{incidentDuration(incident)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Related check timeline</CardTitle></CardHeader>
        <CardContent>
          {timeline === null ? (
            <Skeleton className="h-40 w-full" />
          ) : timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No checks fall inside this incident's window (they may have aged out of raw retention).
            </p>
          ) : (
            <ol className="space-y-2 text-sm">
              {timeline.map((check) => (
                <li key={check.id} className="flex flex-wrap items-center gap-2 border-b pb-2 last:border-0">
                  <time dateTime={check.completedAt} title={formatTimestamp(check.completedAt)} className="font-mono text-xs text-muted-foreground">
                    {formatTimestamp(check.completedAt)}
                  </time>
                  {check.isHealthy ? (
                    <Badge variant="success" className="font-mono">OK</Badge>
                  ) : (
                    <Badge variant="danger" className="font-mono">FAIL</Badge>
                  )}
                  {check.id === incident.triggerCheckId && <Badge variant="warning" className="font-mono">THRESHOLD</Badge>}
                  {check.id === incident.recoveryCheckId && <Badge variant="info" className="font-mono">RECOVERY</Badge>}
                  <span className="font-mono text-xs">{check.statusCode ?? "—"}</span>
                  <span className="font-mono text-xs text-muted-foreground">{check.reasonCode}</span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
