/**
 * Monitor detail page (issue #24; PRD §27.5): configuration summary,
 * uptime badges for 24h/7d/30d/90d (#20), a Recharts response-time chart
 * with labeled maintenance overlays (#15 data), paginated recent checks,
 * monitor incidents, notification-target quick-edit (#16), and run-now.
 * Route shape `/monitors/:id` is the #17 email deep link — stable.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CircleCheck,
  CircleX,
  Loader2,
  RefreshCw,
  Wrench,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiMutate, apiRequest, apiRequestEnvelope, UptimeApiError } from "../lib/api";
import { formatRelative, formatTimestamp } from "../lib/time-format";
import { checksToChartPoints, maintenanceOverlaysForChart } from "../lib/chart-data";
import type { ClientDto, ManualCheckReceipt, MonitorDto } from "../types/monitor";
import type {
  CheckDto,
  MaintenanceWindowDto,
  MonitorIncidentDto,
  NotificationTargetDto,
  UptimeDto,
} from "../types/monitor-detail";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { StatusBadge, isMonitorStatus } from "../components/status-badge";

const CHECKS_PAGE_SIZE = 25;
const UPTIME_WINDOW_LABELS: Array<{ window: UptimeDto["window"]; label: string }> = [
  { window: "24h", label: "24h" },
  { window: "7d", label: "7d" },
  { window: "30d", label: "30d" },
  { window: "90d", label: "90d" },
];

interface Notice {
  kind: "success" | "error";
  text: string;
  requestId?: string | null;
}

function actionError(prefix: string, error: unknown): Notice {
  return {
    kind: "error",
    text: `${prefix} (API category: ${error instanceof UptimeApiError ? error.category : "internal"}).`,
    requestId: error instanceof UptimeApiError ? error.requestId : null,
  };
}

function UptimeBadge({ uptime }: { uptime: UptimeDto | undefined }) {
  if (!uptime) return <Skeleton className="h-6 w-20 rounded-full" />;
  if (uptime.status === "no_data") {
    return (
      <Badge variant="neutral" title="No eligible checks in this window (§26)">
        No data
      </Badge>
    );
  }
  return (
    <Badge
      variant="info"
      title={`${uptime.healthyChecks}/${uptime.eligibleChecks} eligible checks (${uptime.source} data)`}
    >
      {uptime.percentage?.toFixed(2)}%
    </Badge>
  );
}

function ResponseTimeChart({
  checks,
  maintenanceWindows,
  monitor,
}: {
  checks: CheckDto[];
  maintenanceWindows: MaintenanceWindowDto[];
  monitor: MonitorDto;
}) {
  const points = useMemo(() => checksToChartPoints(checks, (iso) => formatTimestamp(iso)), [checks]);
  const range = useMemo(
    () =>
      points.length > 0
        ? { start: points[0].at, end: points[points.length - 1].at }
        : null,
    [points],
  );
  const overlays = useMemo(
    () => (range ? maintenanceOverlaysForChart(maintenanceWindows, monitor, range) : []),
    [maintenanceWindows, monitor, range],
  );

  if (points.length < 2) {
    return <p className="text-sm text-muted-foreground">Not enough response-time data yet.</p>;
  }

  const maxMs = Math.max(...points.map((point) => point.ms));
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <LineChart width={720} height={240} data={points} margin={{ top: 24, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="label" interval="preserveStartEnd" tick={{ fontSize: 11 }} />
          <YAxis domain={[0, Math.ceil(maxMs * 1.1)]} tick={{ fontSize: 11 }} width={48} unit=" ms" />
          <Tooltip />
          {overlays.map((overlay) => {
            const inside = points.filter((point) => point.at >= overlay.startsAt && point.at < overlay.endsAt);
            if (inside.length === 0) return null;
            return (
              <ReferenceArea
                key={overlay.id}
                x1={inside[0].label}
                x2={inside[inside.length - 1].label}
                fill="currentColor"
                fillOpacity={0.15}
                stroke="currentColor"
                strokeDasharray="4 2"
                label={{ value: `Maintenance: ${overlay.title}`, position: "insideTop", fontSize: 11 }}
              />
            );
          })}
          <Line
            type="monotone"
            dataKey="ms"
            name="Response time (ms)"
            stroke="currentColor"
            dot={false}
            isAnimationActive={false}
          />
          <Legend />
        </LineChart>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Wrench className="h-3 w-3" aria-hidden="true" />
        Shaded, labeled regions are maintenance windows overlapping this range (never color alone).
      </p>
    </div>
  );
}

function IncidentStatusBadge({ status }: { status: MonitorIncidentDto["status"] }) {
  const map: Record<MonitorIncidentDto["status"], { label: string; variant: "danger" | "success" | "neutral" }> = {
    open: { label: "OPEN", variant: "danger" },
    resolved: { label: "RESOLVED", variant: "success" },
    closed_admin: { label: "CLOSED", variant: "neutral" },
  };
  const style = map[status];
  return (
    <Badge variant={style.variant} className="font-mono">
      {style.label}
    </Badge>
  );
}

/** Notification targets quick-edit (#16): checkbox = explicit mapping. */
function TargetsPanel({ monitorId }: { monitorId: string }) {
  const queryClient = useQueryClient();
  const targetsQuery = useQuery({
    queryKey: ["notification-targets"],
    queryFn: () => apiRequest<NotificationTargetDto[]>("/api/notification-targets"),
  });
  const mappingsQuery = useQuery({
    queryKey: ["monitor-notification-targets", monitorId],
    queryFn: () => apiRequest<string[]>(`/api/monitors/${monitorId}/notification-targets`),
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Notice | null>(null);

  // PUT replaces the explicit mapping set (PRD §17.8 semantics, #16 route).
  async function putMappings(targetIds: string[]): Promise<void> {
    await apiRequestEnvelope<string[]>(`/api/monitors/${monitorId}/notification-targets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetIds }),
    });
  }

  async function toggle(targetId: string, checked: boolean) {
    const current = mappingsQuery.data ?? [];
    const next = checked
      ? [...new Set([...current, targetId])]
      : current.filter((id) => id !== targetId);
    setPending(true);
    try {
      await putMappings(next);
      await queryClient.invalidateQueries({ queryKey: ["monitor-notification-targets", monitorId] });
      setError(null);
    } catch (cause) {
      setError(actionError("Could not update notification mappings", cause));
    } finally {
      setPending(false);
    }
  }

  if (targetsQuery.isPending || mappingsQuery.isPending) return <Skeleton className="h-24 w-full" />;
  if (targetsQuery.isError || mappingsQuery.isError) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
        Notification targets unavailable.
      </p>
    );
  }

  const mapped = new Set(mappingsQuery.data ?? []);
  const targets = targetsQuery.data ?? [];

  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.text}
          {error.requestId ? ` Correlation id: ${error.requestId}` : null}
        </p>
      )}
      {targets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No notification targets exist yet — create them under Notifications (#26).
        </p>
      ) : (
        <ul className="space-y-2 text-sm">
          {targets.map((target) => (
            <li key={target.id} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <input
                  id={`target-${target.id}`}
                  type="checkbox"
                  checked={mapped.has(target.id)}
                  disabled={pending}
                  onChange={(event) => void toggle(target.id, event.target.checked)}
                />
                <label htmlFor={`target-${target.id}`}>
                  {target.name} <span className="text-muted-foreground">({target.email})</span>
                </label>
              </span>
              {!target.enabled && <Badge variant="neutral">DISABLED</Badge>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MonitorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const monitorId = id ?? "";
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [checksPage, setChecksPage] = useState(1);

  // Reset per-monitor view state during render when the route param changes
  // (the React-endorsed alternative to a setState-in-effect).
  const [lastMonitorId, setLastMonitorId] = useState(monitorId);
  if (lastMonitorId !== monitorId) {
    setLastMonitorId(monitorId);
    setChecksPage(1);
    setNotice(null);
  }

  const monitorQuery = useQuery({
    queryKey: ["monitor", monitorId],
    queryFn: () => apiRequest<MonitorDto>(`/api/monitors/${monitorId}`),
    refetchInterval: 30_000,
    enabled: monitorId !== "",
  });
  const monitor = monitorQuery.data;

  const checksQuery = useQuery({
    queryKey: ["monitor-checks", monitorId, checksPage],
    queryFn: () =>
      apiRequestEnvelope<CheckDto[]>(
        `/api/monitors/${monitorId}/checks?limit=${CHECKS_PAGE_SIZE}&offset=${(checksPage - 1) * CHECKS_PAGE_SIZE}`,
      ),
    enabled: !!monitor,
  });
  const incidentsQuery = useQuery({
    queryKey: ["monitor-incidents", monitorId],
    queryFn: () => apiRequestEnvelope<MonitorIncidentDto[]>(`/api/monitors/${monitorId}/incidents?limit=50`),
    enabled: !!monitor,
  });
  const maintenanceQuery = useQuery({
    queryKey: ["maintenance"],
    queryFn: () => apiRequest<MaintenanceWindowDto[]>("/api/maintenance"),
    enabled: !!monitor,
  });
  const clientsQuery = useQuery({
    queryKey: ["clients"],
    queryFn: () => apiRequest<ClientDto[]>("/api/clients"),
    enabled: !!monitor,
  });

  const runCheck = useMutation({
    mutationFn: () => apiMutate<ManualCheckReceipt>(`/api/monitors/${monitorId}/check`, "POST"),
    onSuccess: (receipt) => {
      setNotice({
        kind: "success",
        text: `Manual check queued (check id ${receipt.checkId}). It appears in the checks table once executed.`,
      });
      void queryClient.invalidateQueries({ queryKey: ["monitor-checks", monitorId] });
    },
    onError: (error) => setNotice(actionError("Run check now failed", error)),
  });

  if (monitorQuery.isError) {
    const notFound = monitorQuery.error instanceof UptimeApiError && monitorQuery.error.category === "not_found";
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            {notFound ? "Monitor not found" : "Monitor unavailable"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {actionError("The monitor could not be loaded", monitorQuery.error).text}
            {monitorQuery.error instanceof UptimeApiError && monitorQuery.error.requestId
              ? ` Correlation id: ${monitorQuery.error.requestId}`
              : null}
          </p>
          <Button variant="outline" onClick={() => void monitorQuery.refetch()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!monitor) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading monitor">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const stateStatus = monitor.archivedAt ? "archived" : monitor.enabled ? (monitor.state?.status ?? "unknown") : "paused";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Link to="/monitors" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
            <ArrowLeft className="mr-1 inline h-4 w-4" aria-hidden="true" />
            Monitors
          </Link>
          <h1 className="text-xl font-semibold">{monitor.name}</h1>
          {stateStatus === "archived" ? (
            <Badge variant="neutral" className="font-mono">ARCHIVED</Badge>
          ) : (
            <StatusBadge status={isMonitorStatus(stateStatus) ? stateStatus : "unknown"} />
          )}
        </div>
        <Button
          disabled={!monitor.enabled || !!monitor.archivedAt || runCheck.isPending}
          title={
            monitor.enabled && !monitor.archivedAt
              ? "Enqueue a diagnostic manual check"
              : "Paused or archived monitors cannot run manual checks"
          }
          onClick={() => runCheck.mutate()}
        >
          {runCheck.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Run check now
        </Button>
      </div>

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={
            notice.kind === "error"
              ? "flex items-start justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm"
              : "flex items-start justify-between gap-2 rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm"
          }
        >
          <span>
            {notice.text}
            {notice.requestId ? ` Correlation id: ${notice.requestId}` : null}
          </span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      {/* Configuration summary (§27.5) */}
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Client</dt>
              <dd>{clientsQuery.data?.find((client) => client.id === monitor.clientId)?.name ?? monitor.clientId}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-muted-foreground">URL</dt>
              <dd className="truncate">
                {monitor.method} <a href={monitor.url} className="underline underline-offset-2" rel="noreferrer" target="_blank">{monitor.url}</a>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Interval</dt>
              <dd className="font-mono">{monitor.intervalSeconds}s</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Timeout</dt>
              <dd className="font-mono">{monitor.timeoutMs} ms</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Max response</dt>
              <dd className="font-mono">{monitor.maxResponseTimeMs === null ? "—" : `${monitor.maxResponseTimeMs} ms`}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Thresholds (fail/rec)</dt>
              <dd className="font-mono">{monitor.failureThreshold}/{monitor.recoveryThreshold}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Expected statuses</dt>
              <dd className="font-mono">{monitor.expectedStatusCodes.join(", ")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Cache-bust</dt>
              <dd>{monitor.cacheBust ? "On" : "Off"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last check</dt>
              <dd>{monitor.state?.lastCheckedAt ? formatRelative(monitor.state.lastCheckedAt) : "never"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last response</dt>
              <dd className="font-mono">{monitor.state?.lastResponseTimeMs === null || monitor.state === null ? "—" : `${monitor.state.lastResponseTimeMs} ms`}</dd>
            </div>
            {monitor.bodyContains && (
              <div>
                <dt className="text-xs text-muted-foreground">Body contains</dt>
                <dd className="truncate font-mono" title={monitor.bodyContains}>{monitor.bodyContains}</dd>
              </div>
            )}
            {monitor.bodyNotContains && (
              <div>
                <dt className="text-xs text-muted-foreground">Body NOT contains</dt>
                <dd className="truncate font-mono" title={monitor.bodyNotContains}>{monitor.bodyNotContains}</dd>
              </div>
            )}
            {monitor.tags && monitor.tags.length > 0 && (
              <div>
                <dt className="text-xs text-muted-foreground">Tags</dt>
                <dd>{monitor.tags.join(", ")}</dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-muted-foreground">Manage</dt>
              <dd>
                <Link to="/monitors" className="underline underline-offset-2">Edit in Monitors list</Link>
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Uptime windows (§27.5; #20 endpoint) */}
      <Card>
        <CardHeader>
          <CardTitle>Uptime</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-6">
            {UPTIME_WINDOW_LABELS.map(({ window, label }) => (
              <UptimeWindowBadge key={window} monitorId={monitorId} window={window} label={label} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Response-time chart with maintenance overlays (§27.5) */}
      <Card>
        <CardHeader>
          <CardTitle>Response time</CardTitle>
        </CardHeader>
        <CardContent>
          {checksQuery.isSuccess ? (
            <ResponseTimeChart
              checks={checksQuery.data.data}
              maintenanceWindows={maintenanceQuery.data ?? []}
              monitor={monitor}
            />
          ) : (
            <Skeleton className="h-60 w-full" />
          )}
        </CardContent>
      </Card>

      {/* Recent checks table (§27.5) */}
      <Card>
        <CardHeader>
          <CardTitle>Recent checks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {checksQuery.isError ? (
            <p className="text-sm text-destructive">{actionError("Checks history unavailable", checksQuery.error).text}</p>
          ) : checksQuery.isSuccess ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Recent checks: time, result, HTTP status, response time, reason, trigger, maintenance flag</caption>
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="py-2 pr-3">Time</th>
                      <th scope="col" className="py-2 pr-3">Result</th>
                      <th scope="col" className="py-2 pr-3">HTTP</th>
                      <th scope="col" className="py-2 pr-3">Response</th>
                      <th scope="col" className="py-2 pr-3">Reason</th>
                      <th scope="col" className="py-2 pr-3">Trigger</th>
                      <th scope="col" className="py-2">Maintenance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checksQuery.data.data.map((check) => (
                      <tr key={check.id} className="border-b last:border-0">
                        <td className="py-2 pr-3">
                          <time dateTime={check.completedAt} title={formatTimestamp(check.completedAt)}>
                            {formatRelative(check.completedAt)}
                          </time>
                        </td>
                        <td className="py-2 pr-3">
                          {check.isHealthy ? (
                            <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                              <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
                              OK
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
                              <CircleX className="h-3.5 w-3.5" aria-hidden="true" />
                              FAIL
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono">{check.statusCode ?? "—"}</td>
                        <td className="py-2 pr-3 font-mono">{check.responseTimeMs === null ? "—" : `${check.responseTimeMs} ms`}</td>
                        <td className="py-2 pr-3 font-mono text-xs" title={check.errorMessage ?? check.reasonCode}>
                          {check.reasonCode}
                        </td>
                        <td className="py-2 pr-3">{check.source === "manual" ? <Badge variant="warning" className="font-mono">MANUAL</Badge> : <Badge variant="neutral" className="font-mono">SCHEDULED</Badge>}</td>
                        <td className="py-2">
                          {check.maintenanceExcluded ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium">
                              <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                              Excluded
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {checksQuery.data.data.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-4 text-center text-muted-foreground">No checks recorded yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  Page {checksPage} · {checksQuery.data.data.length} of {checksQuery.data.pagination?.total ?? 0} checks
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={checksPage <= 1}
                    onClick={() => setChecksPage((current) => Math.max(1, current - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={checksPage * CHECKS_PAGE_SIZE >= (checksQuery.data.pagination?.total ?? 0)}
                    onClick={() => setChecksPage((current) => current + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <Skeleton className="h-48 w-full" />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Incidents (§27.5; links into 025's detail page) */}
        <Card>
          <CardHeader>
            <CardTitle>Incidents</CardTitle>
          </CardHeader>
          <CardContent>
            {incidentsQuery.isError ? (
              <p className="text-sm text-destructive">{actionError("Incidents unavailable", incidentsQuery.error).text}</p>
            ) : incidentsQuery.isSuccess ? (
              incidentsQuery.data.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No incidents recorded for this monitor.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {incidentsQuery.data.data.map((incident) => (
                    <li key={incident.id} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <IncidentStatusBadge status={incident.status} />
                        <Link to={`/incidents/${incident.id}`} className="underline underline-offset-2">
                          {formatTimestamp(incident.openedAt)}
                        </Link>
                      </span>
                      <span className="text-muted-foreground">
                        {incident.status === "open"
                          ? "ongoing"
                          : incident.outageDurationMs === null
                            ? formatRelative(incident.resolvedAt as string)
                            : `${Math.round(incident.outageDurationMs / 60_000)} min`}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
          </CardContent>
        </Card>

        {/* Notification targets quick-edit (#16 mappings) */}
        <Card>
          <CardHeader>
            <CardTitle>Notification targets</CardTitle>
          </CardHeader>
          <CardContent>
            {monitor && <TargetsPanel monitorId={monitor.id} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** One uptime badge per window; each window is its own #20 query. */
function UptimeWindowBadge({ monitorId, window, label }: { monitorId: string; window: UptimeDto["window"]; label: string }) {
  const query = useQuery({
    queryKey: ["monitor-uptime", monitorId, window],
    queryFn: () => apiRequest<UptimeDto>(`/api/monitors/${monitorId}/uptime?window=${window}`),
    enabled: monitorId !== "",
  });
  return (
    <div>
      <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <UptimeBadge uptime={query.data} />
    </div>
  );
}
