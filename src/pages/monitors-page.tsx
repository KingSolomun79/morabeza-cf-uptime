/**
 * Monitors list page (issue #23; PRD §22, §23, §27.4): fleet table with
 * client/status/search filters, inline create/edit/duplicate form, and the
 * per-row actions — run check now (#14), pause/resume (#23), archive with
 * a confirm guard (permanent deletion does not exist in the UI).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { apiMutate, apiRequest, apiRequestEnvelope, UptimeApiError } from "../lib/api";
import { formatRelative, formatTimestamp } from "../lib/time-format";
import type { MonitorConfigInput } from "../lib/monitor-form";
import type { ClientDto, ManualCheckReceipt, MonitorDto } from "../types/monitor";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { StatusBadge, isMonitorStatus } from "../components/status-badge";
import { MonitorForm } from "./monitors-form";
import { filterMonitorList, MONITORS_PAGE_SIZE, paginate } from "./monitors-filters";

/** Transient feedback strip (§38 categories + requestId correlation). */
interface Notice {
  kind: "success" | "warning" | "error";
  text: string;
  requestId?: string | null;
}

type FormTarget =
  | { key: "create"; mode: "create" }
  | { key: string; mode: "edit" | "duplicate"; monitor: MonitorDto };

/** The list row the filters see: DTO + display-only fields. */
type MonitorListRow = MonitorDto & {
  clientName: string;
  /** Display status: machine state, or paused/archived lifecycle override. */
  status: string;
  archived: boolean;
};

function listRow(monitor: MonitorDto, clientsById: Map<string, ClientDto>): MonitorListRow {
  const status = monitor.archivedAt
    ? "archived"
    : monitor.enabled
      ? (monitor.state?.status ?? "unknown")
      : "paused";
  return {
    ...monitor,
    clientName: clientsById.get(monitor.clientId)?.name ?? monitor.clientId,
    status,
    archived: monitor.archivedAt !== null,
  };
}

function errorNotice(prefix: string, error: unknown): Notice {
  const category = error instanceof UptimeApiError ? error.category : "internal";
  const requestId = error instanceof UptimeApiError ? error.requestId : null;
  return {
    kind: "error",
    text: `${prefix} (API category: ${category}).`,
    requestId,
  };
}

export function MonitorsPage() {
  const queryClient = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const [clientFilter, setClientFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const monitorsQuery = useQuery({
    queryKey: ["monitors", includeArchived],
    queryFn: () => apiRequestEnvelope<MonitorDto[]>(`/api/monitors?includeArchived=${includeArchived}`),
    refetchInterval: 30_000,
  });
  const clientsQuery = useQuery({
    queryKey: ["clients"],
    queryFn: () => apiRequest<ClientDto[]>("/api/clients"),
  });

  const clientsById = useMemo(() => {
    const map = new Map<string, ClientDto>();
    for (const client of clientsQuery.data ?? []) map.set(client.id, client);
    return map;
  }, [clientsQuery.data]);

  const invalidateAfterAction = async () => {
    await queryClient.invalidateQueries({ queryKey: ["monitors"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const runCheck = useMutation({
    mutationFn: (monitor: MonitorDto) =>
      apiMutate<ManualCheckReceipt>(`/api/monitors/${monitor.id}/check`, "POST"),
    onSuccess: (receipt, monitor) => {
      setNotice({ kind: "success", text: `Manual check queued for "${monitor.name}" (check id ${receipt.checkId}). It appears in history once executed.` });
    },
    onError: (error) => {
      setNotice(errorNotice("Run check now failed", error));
    },
  });

  const setEnabled = useMutation({
    mutationFn: (input: { monitor: MonitorDto; enabled: boolean }) =>
      apiMutate<MonitorDto>(`/api/monitors/${input.monitor.id}`, "PATCH", { enabled: input.enabled }),
    onSuccess: async (updated) => {
      setNotice({
        kind: "success",
        text: updated.enabled ? `"${updated.name}" resumed — next check is due immediately.` : `"${updated.name}" paused — checks stop and the state resets to UNKNOWN.`,
      });
      await invalidateAfterAction();
    },
    onError: (error) => {
      setNotice(errorNotice("Pause/resume failed", error));
    },
  });

  const archive = useMutation({
    mutationFn: (monitor: MonitorDto) => apiMutate<MonitorDto>(`/api/monitors/${monitor.id}`, "DELETE"),
    onSuccess: async (archived) => {
      setConfirmArchiveId(null);
      setFormTarget((current) =>
        current && current.mode !== "create" && current.monitor.id === archived.id ? null : current,
      );
      setNotice({ kind: "success", text: `"${archived.name}" archived. Its history is preserved; no data was deleted.` });
      await invalidateAfterAction();
    },
    onError: (error) => {
      setNotice(errorNotice("Archive failed", error));
    },
  });

  async function handleCreate(input: MonitorConfigInput) {
    // Envelope form (not apiMutate) to read the §17.2 duplicate-warning sibling.
    const envelope = await apiRequestEnvelope<MonitorDto>("/api/monitors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    setFormTarget(null);
    setNotice(
      envelope.warning
        ? { kind: "warning", text: `Monitor created — ${envelope.warning}` }
        : { kind: "success", text: `Monitor "${envelope.data.name}" created and scheduled.` },
    );
    await invalidateAfterAction();
  }

  async function handleEdit(monitor: MonitorDto, input: MonitorConfigInput) {
    // Full-config PATCH; `enabled` is lifecycle state, not form config.
    await apiMutate<MonitorDto>(`/api/monitors/${monitor.id}`, "PATCH", input);
    setFormTarget(null);
    setNotice({ kind: "success", text: `Monitor "${input.name}" updated.` });
    await invalidateAfterAction();
  }

  const monitors = monitorsQuery.data?.data ?? [];
  const rows = monitors.map((monitor) => listRow(monitor, clientsById));
  const filtered = filterMonitorList(rows, {
    clientId: clientFilter || null,
    status: statusFilter || null,
    query: search,
  });
  const paged = paginate(filtered, page, MONITORS_PAGE_SIZE);

  const busyAction = runCheck.isPending || setEnabled.isPending || archive.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Monitors</h1>
        <Button
          onClick={() => setFormTarget(formTarget?.mode === "create" ? null : { key: "create", mode: "create" })}
        >
          {formTarget?.mode === "create" ? <X className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
          {formTarget?.mode === "create" ? "Close form" : "New monitor"}
        </Button>
      </div>

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={
            notice.kind === "error"
              ? "flex items-start justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm"
              : notice.kind === "warning"
                ? "flex items-start justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
                : "flex items-start justify-between gap-2 rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm"
          }
        >
          <span>
            {notice.text}
            {notice.requestId ? ` Correlation id: ${notice.requestId}` : null}
          </span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {formTarget && (
        <Card>
          <CardHeader>
            <CardTitle>
              {formTarget.mode === "create"
                ? "New monitor"
                : formTarget.mode === "edit"
                  ? `Edit "${formTarget.monitor.name}"`
                  : `Duplicate "${formTarget.monitor.name}" (prefilled — review and submit)`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MonitorForm
              key={formTarget.key}
              mode={formTarget.mode}
              monitor={formTarget.mode === "create" ? undefined : formTarget.monitor}
              clients={clientsQuery.data ?? []}
              submitLabel={formTarget.mode === "create" ? "Create monitor" : "Save changes"}
              onSubmit={async (input) => {
                if (formTarget.mode === "edit") await handleEdit(formTarget.monitor, input);
                else await handleCreate(input);
              }}
              onCancel={() => setFormTarget(null)}
            />
          </CardContent>
        </Card>
      )}

      {monitorsQuery.isPending && (
        <div aria-busy="true" aria-label="Loading monitors">
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {monitorsQuery.isError && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
              Monitors unavailable
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {errorNotice("The monitors list could not be loaded", monitorsQuery.error).text}
              {monitorsQuery.error instanceof UptimeApiError && monitorsQuery.error.requestId
                ? ` Correlation id: ${monitorsQuery.error.requestId}`
                : null}
            </p>
            <Button variant="outline" onClick={() => void monitorsQuery.refetch()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {monitorsQuery.isSuccess && (
        <Card>
          <CardHeader>
            <CardTitle>Fleet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {monitors.length === 0 ? (
              <div className="rounded-md border border-dashed p-8 text-center">
                <p className="font-medium">No monitors yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Use the “New monitor” button above to track your first endpoint.
                </p>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor="monitors-filter-client">Filter by client</label>
                  <select
                    id="monitors-filter-client"
                    className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                    value={clientFilter}
                    onChange={(event) => { setClientFilter(event.target.value); setPage(1); }}
                  >
                    <option value="">All clients</option>
                    {(clientsQuery.data ?? []).map((client) => (
                      <option key={client.id} value={client.id}>{client.name}</option>
                    ))}
                  </select>
                  <label className="sr-only" htmlFor="monitors-filter-status">Filter by status</label>
                  <select
                    id="monitors-filter-status"
                    className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                    value={statusFilter}
                    onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}
                  >
                    <option value="">All statuses</option>
                    <option value="up">Up</option>
                    <option value="down">Down</option>
                    <option value="unknown">Unknown</option>
                    <option value="paused">Paused</option>
                    {includeArchived && <option value="archived">Archived</option>}
                  </select>
                  <label className="sr-only" htmlFor="monitors-filter-search">Search monitors</label>
                  <Input
                    id="monitors-filter-search"
                    type="search"
                    placeholder="Search name, url, client…"
                    className="max-w-xs"
                    value={search}
                    onChange={(event) => { setSearch(event.target.value); setPage(1); }}
                  />
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                      id="monitors-include-archived"
                      type="checkbox"
                      checked={includeArchived}
                      onChange={(event) => { setIncludeArchived(event.target.checked); setPage(1); }}
                    />
                    <label htmlFor="monitors-include-archived">Include archived</label>
                  </span>
                </div>

                {paged.rows.length === 0 ? (
                  <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No monitors match the current filters.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="sr-only">Monitors with status, interval, last check, and management actions</caption>
                      <thead>
                        <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th scope="col" className="py-2 pr-3">Client</th>
                          <th scope="col" className="py-2 pr-3">Monitor</th>
                          <th scope="col" className="py-2 pr-3">Status</th>
                          <th scope="col" className="py-2 pr-3">Interval</th>
                          <th scope="col" className="py-2 pr-3">Last check</th>
                          <th scope="col" className="py-2">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paged.rows.map((row) => (
                          <tr key={row.id} className="border-b last:border-0 align-top">
                            <td className="py-2 pr-3">{row.clientName}</td>
                            <td className="py-2 pr-3">
                              <Link to={`/monitors/${row.id}`} className="font-medium underline-offset-2 hover:underline">
                                {row.name}
                              </Link>
                              <span className="block max-w-72 truncate text-xs text-muted-foreground">{row.url}</span>
                            </td>
                            <td className="py-2 pr-3">
                              {row.archived ? (
                                <Badge variant="neutral" className="font-mono">ARCHIVED</Badge>
                              ) : (
                                <StatusBadge
                                  status={isMonitorStatus(row.status) ? row.status : "unknown"}
                                  note={row.state?.lastCheckedAt ? `last check ${formatTimestamp(row.state.lastCheckedAt)}` : undefined}
                                />
                              )}
                            </td>
                            <td className="py-2 pr-3 font-mono">{row.intervalSeconds}s</td>
                            <td className="py-2 pr-3">
                              {row.state?.lastCheckedAt ? (
                                <time dateTime={row.state.lastCheckedAt} title={formatTimestamp(row.state.lastCheckedAt)}>
                                  {formatRelative(row.state.lastCheckedAt)}
                                </time>
                              ) : (
                                <span className="text-muted-foreground">never</span>
                              )}
                            </td>
                            <td className="py-2">
                              {row.archived ? (
                                <span className="text-xs text-muted-foreground">Archived monitors are read-only.</span>
                              ) : (
                                <div className="flex flex-wrap gap-1" aria-label={`Actions for ${row.name}`}>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={!row.enabled || busyAction}
                                    title={row.enabled ? "Enqueue a diagnostic manual check" : "Paused monitors cannot run manual checks"}
                                    onClick={() => runCheck.mutate(row)}
                                  >
                                    {runCheck.isPending && runCheck.variables?.id === row.id && (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                    )}
                                    Run now
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busyAction}
                                    onClick={() => setEnabled.mutate({ monitor: row, enabled: !row.enabled })}
                                  >
                                    {row.enabled ? "Pause" : "Resume"}
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setFormTarget({ key: `edit-${row.id}`, mode: "edit", monitor: row })}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setFormTarget({ key: `duplicate-${row.id}`, mode: "duplicate", monitor: row })}
                                  >
                                    Duplicate
                                  </Button>
                                  {confirmArchiveId === row.id ? (
                                    <span className="inline-flex items-center gap-1">
                                      <span className="text-xs text-muted-foreground">Archive this monitor?</span>
                                      <Button
                                        variant="destructive"
                                        size="sm"
                                        disabled={busyAction}
                                        onClick={() => archive.mutate(row)}
                                      >
                                        Confirm archive
                                      </Button>
                                      <Button variant="ghost" size="sm" onClick={() => setConfirmArchiveId(null)}>
                                        Keep
                                      </Button>
                                    </span>
                                  ) : (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={busyAction}
                                      onClick={() => setConfirmArchiveId(row.id)}
                                    >
                                      Archive
                                    </Button>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {filtered.length > MONITORS_PAGE_SIZE && (
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
      )}
    </div>
  );
}
