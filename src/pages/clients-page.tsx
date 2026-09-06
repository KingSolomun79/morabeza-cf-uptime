/**
 * Clients pages (issue #25; PRD §27.6, §24): the client list with per-client
 * monitor/status counts, open incidents, and aggregate uptime, plus the
 * client detail route. Data comes from GET /api/clients (#4) + the #22
 * dashboard aggregate (no new endpoints). Client CRUD hits #4; archiving is
 * confirm-guarded and there is no client login concept anywhere (§39).
 */
import { useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus, RefreshCw, X } from "lucide-react";
import { apiMutate, apiRequest, apiRequestEnvelope, UptimeApiError } from "../lib/api";
import { slugifyName } from "../lib/utils";
import { formatRelative } from "../lib/time-format";
import type { ClientDto } from "../types/monitor";
import type { DashboardDto } from "../types/dashboard";
import type { MonitorIncidentDto } from "../types/monitor-detail";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { StatusBadge, isMonitorStatus } from "../components/status-badge";

// Mirrors SLUG_PATTERN in worker/routes/clients.ts — the server remains
// authoritative; keep the two in sync (pinned by the clients-page tests).
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

interface ClientRollup {
  client: ClientDto;
  monitors: DashboardDto["monitors"];
  up: number;
  down: number;
  paused: number;
  openIncidents: number;
  /** Simple mean of per-monitor 24h uptime where data exists (null = no data). */
  uptime24h: number | null;
}

function rollupClients(clients: ClientDto[] | undefined, dashboard: DashboardDto | undefined): ClientRollup[] {
  return (clients ?? []).map((client) => {
    const monitors = (dashboard?.monitors ?? []).filter((row) => row.clientId === client.id);
    const withData = monitors.filter((row) => row.uptime24h.status === "ok" && row.uptime24h.percentage !== null);
    return {
      client,
      monitors,
      up: monitors.filter((row) => row.status === "up").length,
      down: monitors.filter((row) => row.status === "down").length,
      paused: monitors.filter((row) => row.status === "paused").length,
      openIncidents: monitors.filter((row) => row.openIncidentId !== null).length,
      uptime24h:
        withData.length > 0
          ? withData.reduce((sum, row) => sum + (row.uptime24h.percentage as number), 0) / withData.length
          : null,
    };
  });
}

function UptimeIndicator({ value }: { value: number | null }) {
  if (value === null) return <span className="text-sm text-muted-foreground">No data</span>;
  return (
    <span className="font-mono text-sm" title="Mean of member monitors' 24h uptime">
      {value.toFixed(2)}%
    </span>
  );
}

/** Shared client create/edit form (name/slug/notes; #4 endpoints). */
function ClientForm({
  client,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  client?: ClientDto;
  submitLabel: string;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(client?.name ?? "");
  const [slug, setSlug] = useState(client?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(client !== undefined);
  const [notes, setNotes] = useState(client?.notes ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<UptimeApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const fieldErrors: Record<string, string> = {};
    if (name.trim() === "") fieldErrors.name = "name is required";
    if (!SLUG_PATTERN.test(slug.trim())) fieldErrors.slug = "slug must be lowercase letters, digits, and dashes";
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    setSubmitting(true);
    setServerError(null);
    try {
      const body = { name: name.trim(), slug: slug.trim(), notes: notes.trim() === "" ? null : notes.trim() };
      await onSubmit(body);
    } catch (cause) {
      if (cause instanceof UptimeApiError) setServerError(cause);
      else setServerError(new UptimeApiError("internal", cause instanceof Error ? cause.message : "unexpected failure"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4" aria-label="Client form" noValidate>
      {serverError && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <span className="font-medium">The API rejected the client ({serverError.category}).</span> {serverError.message}
          {serverError.requestId ? ` Correlation id: ${serverError.requestId}` : null}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="client-name" className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
          <Input
            id="client-name"
            value={name}
            aria-invalid={errors.name ? true : undefined}
            onChange={(event) => {
              const next = event.target.value;
              setName(next);
              // Owner request (#29): auto-derive the slug while the user has
              // not customised it; edit mode starts untouched=false→true so
              // existing slugs are never silently rewritten.
              if (!slugTouched) setSlug(slugifyName(next));
            }}
          />
          {errors.name && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.name}</p>}
        </div>
        <div>
          <label htmlFor="client-slug" className="mb-1 block text-xs font-medium text-muted-foreground">Slug</label>
          <Input
            id="client-slug"
            value={slug}
            aria-invalid={errors.slug ? true : undefined}
            onChange={(event) => {
              setSlugTouched(true);
              setSlug(event.target.value);
            }}
          />
          {!slugTouched && <p className="mt-1 text-xs text-muted-foreground">Auto-filled from the name — edit to override.</p>}
          {errors.slug && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.slug}</p>}
        </div>
      </div>
      <div>
        <label htmlFor="client-notes" className="mb-1 block text-xs font-medium text-muted-foreground">Notes (optional)</label>
        <Input id="client-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={submitting}>{submitLabel}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function ClientsPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);

  const clientsQuery = useQuery({ queryKey: ["clients"], queryFn: () => apiRequest<ClientDto[]>("/api/clients") });
  const dashboardQuery = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiRequestEnvelope<DashboardDto>("/api/dashboard"),
    refetchInterval: 30_000,
  });

  const rollups = useMemo(() => rollupClients(clientsQuery.data, dashboardQuery.data?.data), [clientsQuery.data, dashboardQuery.data]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["clients"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Clients</h1>
        <Button onClick={() => setFormOpen(!formOpen)}>
          {formOpen ? <X className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
          {formOpen ? "Close form" : "New client"}
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
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {formOpen && (
        <Card>
          <CardHeader><CardTitle>New client</CardTitle></CardHeader>
          <CardContent>
            <ClientForm
              key="create"
              submitLabel="Create client"
              onSubmit={async (body) => {
                await apiMutate<ClientDto>("/api/clients", "POST", body);
                setFormOpen(false);
                setNotice({ kind: "success", text: `Client "${String(body.name)}" created.` });
                await invalidate();
              }}
              onCancel={() => setFormOpen(false)}
            />
          </CardContent>
        </Card>
      )}

      {clientsQuery.isPending && (
        <div aria-busy="true" aria-label="Loading clients"><Skeleton className="h-48 w-full" /></div>
      )}

      {clientsQuery.isError && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
              Clients unavailable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void clientsQuery.refetch()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {clientsQuery.isSuccess && rollups.length === 0 && (
        <div className="rounded-md border border-dashed p-8 text-center">
          <p className="font-medium">No clients yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Create a client to group monitors per customer or site.</p>
        </div>
      )}

      {clientsQuery.isSuccess && rollups.length > 0 && (
        <Card>
          <CardHeader><CardTitle>All clients</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Clients with monitor counts, status summary, open incidents, aggregate uptime, and actions</caption>
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th scope="col" className="py-2 pr-3">Client</th>
                    <th scope="col" className="py-2 pr-3">Monitors</th>
                    <th scope="col" className="py-2 pr-3">Up / Down / Paused</th>
                    <th scope="col" className="py-2 pr-3">Open incidents</th>
                    <th scope="col" className="py-2 pr-3">Aggregate uptime (24h)</th>
                    <th scope="col" className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rollups.map((rollup) => (
                    <tr key={rollup.client.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        <Link to={`/clients/${rollup.client.id}`} className="font-medium underline-offset-2 hover:underline">
                          {rollup.client.name}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{rollup.client.slug}</span>
                      </td>
                      <td className="py-2 pr-3 font-mono">{rollup.monitors.length}</td>
                      <td className="py-2 pr-3 font-mono">{rollup.up} / {rollup.down} / {rollup.paused}</td>
                      <td className="py-2 pr-3">
                        {rollup.openIncidents > 0 ? (
                          <span className="font-medium text-red-600 dark:text-red-400">{rollup.openIncidents}</span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                      <td className="py-2 pr-3"><UptimeIndicator value={rollup.uptime24h} /></td>
                      <td className="py-2">
                        <div className="flex gap-1" role="group" aria-label={`Actions for ${rollup.client.name}`}>
                          {confirmArchiveId === rollup.client.id ? (
                            <>
                              <span className="text-xs text-muted-foreground">Archive this client?</span>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={async () => {
                                  try {
                                    await apiMutate<ClientDto>(`/api/clients/${rollup.client.id}`, "DELETE");
                                    setNotice({ kind: "success", text: `Client "${rollup.client.name}" archived.` });
                                  } catch (cause) {
                                    setNotice(actionError("Archive failed", cause));
                                  }
                                  setConfirmArchiveId(null);
                                  await invalidate();
                                }}
                              >
                                Confirm archive
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setConfirmArchiveId(null)}>Keep</Button>
                            </>
                          ) : (
                            <Button variant="ghost" size="sm" onClick={() => setConfirmArchiveId(rollup.client.id)}>
                              Archive
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Client detail (§27.6): counts, aggregate uptime, open incidents, members. */
export function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const clientId = id ?? "";
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const clientsQuery = useQuery({
    queryKey: ["clients"],
    queryFn: () => apiRequest<ClientDto[]>("/api/clients"),
    enabled: clientId !== "",
  });
  const client = clientsQuery.data?.find((candidate) => candidate.id === clientId);
  const dashboardQuery = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiRequestEnvelope<DashboardDto>("/api/dashboard"),
    enabled: clientId !== "",
    refetchInterval: 30_000,
  });
  const incidentsQuery = useQuery({
    queryKey: ["incidents", "client-detail"],
    queryFn: () => apiRequestEnvelope<MonitorIncidentDto[]>("/api/incidents?limit=200"),
    enabled: clientId !== "",
  });

  const rollups = useMemo(
    () => rollupClients(clientsQuery.data ?? [], dashboardQuery.data?.data).filter((rollup) => rollup.client.id === clientId),
    [clientsQuery.data, dashboardQuery.data, clientId],
  );
  const rollup = rollups[0];

  const memberIds = useMemo(
    () => new Set(rollup?.monitors.map((row) => row.id) ?? []),
    [rollup],
  );
  const clientIncidents = useMemo(
    () => (incidentsQuery.data?.data ?? []).filter((incident) => memberIds.has(incident.monitorId)),
    [incidentsQuery.data, memberIds],
  );

  if (clientsQuery.isPending) {
    return <div aria-busy="true" aria-label="Loading client"><Skeleton className="h-48 w-full" /></div>;
  }
  if (clientsQuery.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            Client unavailable
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void clientsQuery.refetch()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!client) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            Client not found
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Link to="/clients" className="text-sm underline underline-offset-2">Back to clients</Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link to="/clients" className="text-sm text-muted-foreground underline-offset-2 hover:underline">Clients</Link>
          <h1 className="text-xl font-semibold">{client.name}</h1>
          <p className="text-xs text-muted-foreground">{client.slug}{client.notes ? ` · ${client.notes}` : null}</p>
        </div>
        <Button variant="outline" onClick={() => setEditOpen(!editOpen)}>
          {editOpen ? <X className="h-4 w-4" aria-hidden="true" /> : null}
          {editOpen ? "Close editor" : "Edit client"}
        </Button>
      </div>

      {notice && (
        <div role="status" className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm">
          {notice.text}
          {notice.requestId ? ` Correlation id: ${notice.requestId}` : null}
        </div>
      )}

      {editOpen && (
        <Card>
          <CardHeader><CardTitle>Edit "{client.name}"</CardTitle></CardHeader>
          <CardContent>
            <ClientForm
              key={`edit-${client.id}-${client.updatedAt}`}
              client={client}
              submitLabel="Save changes"
              onSubmit={async (body) => {
                await apiMutate<ClientDto>(`/api/clients/${client.id}`, "PATCH", body);
                setEditOpen(false);
                setNotice({ kind: "success", text: "Client updated." });
                await queryClient.invalidateQueries({ queryKey: ["clients"] });
              }}
              onCancel={() => setEditOpen(false)}
            />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Monitors</p><p className="text-2xl font-semibold">{rollup?.monitors.length ?? 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Up</p><p className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">{rollup?.up ?? 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Down</p><p className="text-2xl font-semibold text-red-600 dark:text-red-400">{rollup?.down ?? 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Paused</p><p className="text-2xl font-semibold">{rollup?.paused ?? 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Open incidents</p><p className={`text-2xl font-semibold ${(rollup?.openIncidents ?? 0) > 0 ? "text-red-600 dark:text-red-400" : ""}`}>{rollup?.openIncidents ?? 0}</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Aggregate uptime (24h)</CardTitle></CardHeader>
        <CardContent>
          <UptimeIndicator value={rollup?.uptime24h ?? null} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Member monitors</CardTitle></CardHeader>
          <CardContent>
            {(rollup?.monitors.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No monitors belong to this client yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {rollup?.monitors.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <StatusBadge status={row.inMaintenance ? "maintenance" : isMonitorStatus(row.status) ? row.status : "unknown"} />
                      <Link to={`/monitors/${row.id}`} className="font-medium underline-offset-2 hover:underline">{row.name}</Link>
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {row.uptime24h.status === "ok" ? `${row.uptime24h.percentage?.toFixed(2)}%` : "No data"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Open incidents</CardTitle></CardHeader>
          <CardContent>
            {clientIncidents.filter((incident) => incident.status === "open").length === 0 ? (
              <p className="text-sm text-muted-foreground">No open incidents for this client.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {clientIncidents
                  .filter((incident) => incident.status === "open")
                  .map((incident) => (
                    <li key={incident.id} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <Badge variant="danger" className="font-mono">OPEN</Badge>
                        <Link to={`/incidents/${incident.id}`} className="underline underline-offset-2">Incident</Link>
                      </span>
                      <span className="text-xs text-muted-foreground">since {formatRelative(incident.openedAt)}</span>
                    </li>
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
