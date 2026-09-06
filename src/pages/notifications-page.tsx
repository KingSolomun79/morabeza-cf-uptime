/**
 * Notifications page (issue #26; PRD §27.9): verified recipient CRUD (#16),
 * per-monitor association editor, Send test email (#17 — queued through the
 * pipeline, never inline), and the delivery log from notification_events
 * (status/attempts/last_error) so failed sends are visible without D1.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Plus, Send, X } from "lucide-react";
import { apiMutate, apiRequest, apiRequestEnvelope, UptimeApiError } from "../lib/api";
import { formatTimestamp } from "../lib/time-format";
import type { ClientDto, MonitorDto } from "../types/monitor";
import type { NotificationEventDto } from "../types/system";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";

const EVENTS_PAGE_SIZE = 25;

interface Notice {
  kind: "success" | "warning" | "error";
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

/** sent/pending/sending/failed → text badges; unknown statuses stay neutral. */
function EventStatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: "success" | "danger" | "info" | "neutral"; label: string }> = {
    sent: { variant: "success", label: "SENT" },
    failed: { variant: "danger", label: "FAILED" },
    sending: { variant: "info", label: "SENDING" },
    pending: { variant: "neutral", label: "PENDING" },
  };
  const style = map[status] ?? { variant: "neutral" as const, label: status.toUpperCase() };
  return <Badge variant={style.variant} className="font-mono">{style.label}</Badge>;
}

/** Create/edit form for a notification target (#16 schema mirrored). */
function TargetForm({
  target,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  target?: { id: string; name: string; email: string; isDefault: boolean };
  submitLabel: string;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(target?.name ?? "");
  const [email, setEmail] = useState(target?.email ?? "");
  const [isDefault, setIsDefault] = useState(target?.isDefault ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<UptimeApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const fieldErrors: Record<string, string> = {};
    if (name.trim() === "") fieldErrors.name = "name is required";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) fieldErrors.email = "enter a valid email address";
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    setSubmitting(true);
    setServerError(null);
    try {
      await onSubmit({ name: name.trim(), email: email.trim(), isDefault });
    } catch (cause) {
      if (cause instanceof UptimeApiError) setServerError(cause);
      else setServerError(new UptimeApiError("internal", cause instanceof Error ? cause.message : "unexpected failure"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4" aria-label="Target form" noValidate>
      {serverError && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <span className="font-medium">The API rejected the target ({serverError.category}).</span> {serverError.message}
          {serverError.requestId ? ` Correlation id: ${serverError.requestId}` : null}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="target-name" className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
          <Input id="target-name" value={name} aria-invalid={errors.name ? true : undefined} aria-describedby={errors.name ? "target-name-error" : undefined} onChange={(event) => setName(event.target.value)} />
          {errors.name && <p id="target-name-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.name}</p>}
        </div>
        <div>
          <label htmlFor="target-email" className="mb-1 block text-xs font-medium text-muted-foreground">Email</label>
          <Input id="target-email" type="email" value={email} aria-invalid={errors.email ? true : undefined} aria-describedby={errors.email ? "target-email-error" : undefined} onChange={(event) => setEmail(event.target.value)} />
          {errors.email && <p id="target-email-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.email}</p>}
        </div>
      </div>
      <span className="flex items-center gap-2 text-sm">
        <input id="target-isDefault" type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
        <label htmlFor="target-isDefault">Default target (monitors without explicit associations)</label>
      </span>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={submitting}>{submitLabel}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/** Monitor → targets association editor (PUT full replacement, #16 route). */
function AssociationsEditor({ monitors }: { monitors: MonitorDto[] }) {
  const queryClient = useQueryClient();
  const [monitorId, setMonitorId] = useState("");
  const targetsQuery = useQuery({
    queryKey: ["notification-targets"],
    queryFn: () => apiRequest<Array<{ id: string; name: string; email: string; enabled: boolean; isDefault: boolean }>>("/api/notification-targets"),
  });
  const mappingsQuery = useQuery({
    queryKey: ["monitor-notification-targets", monitorId],
    queryFn: () => apiRequest<string[]>(`/api/monitors/${monitorId}/notification-targets`),
    enabled: monitorId !== "",
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(targetId: string, checked: boolean) {
    const current = mappingsQuery.data ?? [];
    const next = checked ? [...new Set([...current, targetId])] : current.filter((id) => id !== targetId);
    setPending(true);
    try {
      // PUT replaces the explicit mapping set (#16 route; PRD §17.8).
      await apiRequestEnvelope<string[]>(`/api/monitors/${monitorId}/notification-targets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetIds: next }),
      });
      await queryClient.invalidateQueries({ queryKey: ["monitor-notification-targets", monitorId] });
      setError(null);
    } catch (cause) {
      setError(cause instanceof UptimeApiError ? cause.message : "could not update associations");
    } finally {
      setPending(false);
    }
  }

  const mapped = new Set(mappingsQuery.data ?? []);

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="associations-monitor" className="mb-1 block text-xs font-medium text-muted-foreground">Monitor</label>
        <select
          id="associations-monitor"
          className="h-9 w-full max-w-sm rounded-md border border-input bg-transparent px-2 text-sm"
          value={monitorId}
          onChange={(event) => setMonitorId(event.target.value)}
        >
          <option value="">Select a monitor…</option>
          {monitors.map((monitor) => (
            <option key={monitor.id} value={monitor.id}>{monitor.name}</option>
          ))}
        </select>
      </div>
      {monitorId === "" ? (
        <p className="text-sm text-muted-foreground">Pick a monitor to edit which targets receive its alerts.</p>
      ) : targetsQuery.isPending || mappingsQuery.isPending ? (
        <Skeleton className="h-20 w-full max-w-sm" />
      ) : (
        <div className="space-y-2 text-sm">
          {error && <p role="alert" className="text-destructive">{error}</p>}
          {(targetsQuery.data ?? []).length === 0 ? (
            <p className="text-muted-foreground">No targets exist yet — create one above.</p>
          ) : (
            (targetsQuery.data ?? []).map((target) => (
              <span key={target.id} className="flex items-center gap-2">
                <input
                  id={`assoc-${target.id}`}
                  type="checkbox"
                  checked={mapped.has(target.id)}
                  disabled={pending}
                  onChange={(event) => void toggle(target.id, event.target.checked)}
                />
                <label htmlFor={`assoc-${target.id}`}>{target.name} <span className="text-muted-foreground">({target.email})</span></label>
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [formTarget, setFormTarget] = useState<
    | { key: "create"; mode: "create" }
    | { key: string; mode: "edit"; target: { id: string; name: string; email: string; isDefault: boolean } }
    | null
  >(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [eventsPage, setEventsPage] = useState(1);

  const targetsQuery = useQuery({
    queryKey: ["notification-targets"],
    queryFn: () => apiRequest<Array<{ id: string; name: string; email: string; enabled: boolean; isDefault: boolean; createdAt: string; updatedAt: string }>>("/api/notification-targets"),
  });
  const monitorsQuery = useQuery({
    queryKey: ["monitors", false],
    queryFn: () => apiRequest<MonitorDto[]>("/api/monitors?includeArchived=false"),
  });
  const clientsQuery = useQuery({ queryKey: ["clients"], queryFn: () => apiRequest<ClientDto[]>("/api/clients") });
  const eventsQuery = useQuery({
    queryKey: ["notification-events", eventsPage],
    queryFn: () =>
      apiRequestEnvelope<NotificationEventDto[]>(
        `/api/notification-events?limit=${EVENTS_PAGE_SIZE}&offset=${(eventsPage - 1) * EVENTS_PAGE_SIZE}`,
      ),
    refetchInterval: 30_000,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["notification-targets"] });
    await queryClient.invalidateQueries({ queryKey: ["notification-events"] });
  };

  async function sendTest(target: { id: string; email: string }) {
    setTestingId(target.id);
    try {
      const envelope = await apiRequestEnvelope<{ notificationEventId: string }>(`/api/notification-targets/${target.id}/test`, { method: "POST" });
      setNotice({
        kind: "success",
        text: `Test email queued to ${target.email} (event ${envelope.data.notificationEventId}). Its outcome appears in the delivery log below.`,
      });
      await queryClient.invalidateQueries({ queryKey: ["notification-events"] });
    } catch (cause) {
      setNotice(actionError("Send test email failed", cause));
    } finally {
      setTestingId(null);
    }
  }

  const clientNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const client of clientsQuery.data ?? []) map.set(client.id, client.name);
    return map;
  }, [clientsQuery.data]);
  const monitorById = useMemo(() => {
    const map = new Map<string, MonitorDto>();
    for (const monitor of monitorsQuery.data ?? []) map.set(monitor.id, monitor);
    return map;
  }, [monitorsQuery.data]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Notifications</h1>
        <Button
          onClick={() => setFormTarget(formTarget === null ? { key: "create", mode: "create" } : null)}
        >
          {formTarget === null ? <Plus className="h-4 w-4" aria-hidden="true" /> : <X className="h-4 w-4" aria-hidden="true" />}
          {formTarget === null ? "New target" : "Close form"}
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
            <CardTitle>{formTarget.mode === "create" ? "New notification target" : `Edit "${formTarget.target.name}"`}</CardTitle>
          </CardHeader>
          <CardContent>
            <TargetForm
              key={formTarget.key}
              target={formTarget.mode === "edit" ? formTarget.target : undefined}
              submitLabel={formTarget.mode === "create" ? "Create target" : "Save changes"}
              onSubmit={async (body) => {
                if (formTarget.mode === "edit") {
                  await apiMutate(`/api/notification-targets/${formTarget.target.id}`, "PATCH", body);
                } else {
                  await apiMutate("/api/notification-targets", "POST", body);
                }
                setFormTarget(null);
                setNotice({ kind: "success", text: `Target "${String(body.name)}" ${formTarget.mode === "edit" ? "updated" : "created"}.` });
                await invalidate();
              }}
              onCancel={() => setFormTarget(null)}
            />
          </CardContent>
        </Card>
      )}

      {targetsQuery.isPending && (
        <div aria-busy="true" aria-label="Loading targets"><Skeleton className="h-40 w-full" /></div>
      )}

      {targetsQuery.isError && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
              Targets unavailable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void targetsQuery.refetch()}>Retry</Button>
          </CardContent>
        </Card>
      )}

      {targetsQuery.isSuccess && (
        <Card>
          <CardHeader><CardTitle>Recipients</CardTitle></CardHeader>
          <CardContent>
            {(targetsQuery.data ?? []).length === 0 ? (
              <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No notification targets yet — create one to receive DOWN/RECOVERED alerts.
              </p>
            ) : (
              <ul className="space-y-2">
                {(targetsQuery.data ?? []).map((target) => (
                  <li key={target.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                    <span className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{target.name}</span>
                      <span className="text-muted-foreground">({target.email})</span>
                      {target.isDefault && <Badge variant="info" className="font-mono">DEFAULT</Badge>}
                      {!target.enabled && <Badge variant="neutral" className="font-mono">DISABLED</Badge>}
                    </span>
                    <span className="flex flex-wrap gap-1" role="group" aria-label={`Actions for ${target.name}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!target.enabled || testingId !== null}
                        title={target.enabled ? "Queues a test email through the #17 pipeline" : "Disabled targets cannot receive test emails"}
                        onClick={() => void sendTest(target)}
                      >
                        {testingId === target.id && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                        <Send className="h-3.5 w-3.5" aria-hidden="true" />
                        Send test email
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setFormTarget({ key: `edit-${target.id}`, mode: "edit", target })
                        }
                      >
                        Edit
                      </Button>
                      {confirmDeleteId === target.id ? (
                        <>
                          <span className="text-xs text-muted-foreground">Delete this target?</span>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={async () => {
                              try {
                                await apiMutate(`/api/notification-targets/${target.id}`, "DELETE");
                                setNotice({ kind: "success", text: `Target "${target.name}" deleted.` });
                              } catch (cause) {
                                setNotice(actionError("Delete failed", cause));
                              }
                              setConfirmDeleteId(null);
                              await invalidate();
                            }}
                          >
                            Confirm delete
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Keep</Button>
                        </>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(target.id)}>
                          Delete
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Monitor associations</CardTitle></CardHeader>
          <CardContent>
            <AssociationsEditor monitors={monitorsQuery.data ?? []} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Delivery log</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {eventsQuery.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : eventsQuery.isError ? (
              <p className="text-sm text-destructive">{actionError("Delivery log unavailable", eventsQuery.error).text}</p>
            ) : eventsQuery.data.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No notification events yet.</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Notification delivery log: time, type, target, monitor, status, attempts, last error</caption>
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th scope="col" className="py-2 pr-3">Time</th>
                        <th scope="col" className="py-2 pr-3">Type</th>
                        <th scope="col" className="py-2 pr-3">Target</th>
                        <th scope="col" className="py-2 pr-3">Status</th>
                        <th scope="col" className="py-2 pr-3">Tries</th>
                        <th scope="col" className="py-2">Last error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {eventsQuery.data.data.map((event) => {
                        const monitor = event.monitorId ? monitorById.get(event.monitorId) : undefined;
                        return (
                          <tr key={event.id} className="border-b last:border-0">
                            <td className="py-2 pr-3">
                              <time dateTime={event.createdAt} title={formatTimestamp(event.createdAt)}>{formatTimestamp(event.createdAt)}</time>
                            </td>
                            <td className="py-2 pr-3 font-mono text-xs uppercase">{event.type}</td>
                            <td className="py-2 pr-3">{event.targetEmail}</td>
                            <td className="py-2 pr-3">
                              <EventStatusBadge status={event.status} />
                              {monitor ? (
                                <span className="ml-1 text-xs text-muted-foreground" title={clientNameById.get(monitor.clientId) ?? monitor.clientId}>
                                  {monitor.name}
                                </span>
                              ) : null}
                            </td>
                            <td className="py-2 pr-3 font-mono">{event.attempts}</td>
                            <td className="py-2 max-w-40 truncate font-mono text-xs" title={event.lastError ?? ""}>
                              {event.lastError ?? "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>Page {eventsPage}</span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={eventsPage <= 1} onClick={() => setEventsPage((current) => Math.max(1, current - 1))}>
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={eventsPage * EVENTS_PAGE_SIZE >= (eventsQuery.data.pagination?.total ?? 0)}
                      onClick={() => setEventsPage((current) => current + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
