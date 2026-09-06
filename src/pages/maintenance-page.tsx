/**
 * Maintenance page (issue #25; PRD §14, §27.8): create/edit/cancel windows
 * with a dependent scope picker (§14.2: global has no target, client/monitor
 * require one), Active/Upcoming/Past/Cancelled sections, and display-zone
 * (Atlantic/Cape_Verde) wall-clock inputs persisted as UTC. Cancellation is
 * confirm-guarded; there is no hard delete.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Plus, RefreshCw, Wrench, X } from "lucide-react";
import { apiMutate, apiRequest, UptimeApiError } from "../lib/api";
import { formatTimestamp, formatDuration } from "../lib/time-format";
import { utcToWallInput } from "../lib/datetime-local";
import {
  emptyMaintenanceFormValues,
  MAINTENANCE_SCOPE_TYPES,
  validateMaintenanceForm,
  windowToFormValues,
  type MaintenanceFormValues,
  type MaintenanceWindowInput,
} from "../lib/maintenance-form";
import type { ClientDto, MonitorDto } from "../types/monitor";
import type { MaintenanceWindowDto, MaintenanceScopeType } from "../types/monitor-detail";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";

interface Notice {
  kind: "success" | "error";
  text: string;
  requestId?: string | null;
}

type FormTarget =
  | { key: "create"; mode: "create" }
  | { key: string; mode: "edit"; window: MaintenanceWindowDto };

function lifecycle(window: MaintenanceWindowDto, nowMs: number): "active" | "upcoming" | "past" | "cancelled" {
  if (window.cancelledAt !== null) return "cancelled";
  const start = Date.parse(window.startsAt);
  const end = Date.parse(window.endsAt);
  if (start <= nowMs && nowMs < end) return "active";
  if (start > nowMs) return "upcoming";
  return "past";
}

const LIFECYCLE_SECTIONS: Array<{ key: "active" | "upcoming" | "past" | "cancelled"; title: string; hint: string }> = [
  { key: "active", title: "Active", hint: "Checks during these windows are excluded from alerting and uptime (§14)." },
  { key: "upcoming", title: "Upcoming", hint: "Scheduled to start in the future." },
  { key: "past", title: "Past", hint: "Finished windows — history is preserved." },
  { key: "cancelled", title: "Cancelled", hint: "Cancelled windows never re-activate." },
];

function scopeLabel(window: MaintenanceWindowDto, clients: ClientDto[], monitors: MonitorDto[]): string {
  if (window.scopeType === "global") return "Global";
  if (window.scopeType === "client") {
    return `Client: ${clients.find((client) => client.id === window.scopeId)?.name ?? window.scopeId}`;
  }
  return `Monitor: ${monitors.find((monitor) => monitor.id === window.scopeId)?.name ?? window.scopeId}`;
}

function MaintenanceForm({
  mode,
  window,
  clients,
  monitors,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  window?: MaintenanceWindowDto;
  clients: ClientDto[];
  monitors: MonitorDto[];
  submitLabel: string;
  onSubmit: (input: MaintenanceWindowInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<MaintenanceFormValues>(() =>
    mode === "edit" && window ? windowToFormValues(window, (iso) => utcToWallInput(iso)) : emptyMaintenanceFormValues(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<UptimeApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = <K extends keyof MaintenanceFormValues>(field: K, value: MaintenanceFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const validation = validateMaintenanceForm(values);
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setServerError(null);
    setSubmitting(true);
    try {
      await onSubmit(validation.input);
    } catch (cause) {
      if (cause instanceof UptimeApiError) setServerError(cause);
      else
        setServerError(
          new UptimeApiError("internal", cause instanceof Error ? cause.message : "unexpected submit failure"),
        );
    } finally {
      setSubmitting(false);
    }
  }

  const labelClass = "mb-1 block text-xs font-medium text-muted-foreground";

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4" aria-label="Maintenance form" noValidate>
      {serverError && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <span className="font-medium">The API rejected the window ({serverError.category}).</span> {serverError.message}
          {serverError.requestId ? ` Correlation id: ${serverError.requestId}` : null}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="maintenance-title" className={labelClass}>Title</label>
          <Input id="maintenance-title" value={values.title} aria-invalid={errors.title ? true : undefined} aria-describedby={errors.title ? "maintenance-title-error" : undefined} onChange={(event) => set("title", event.target.value)} />
          {errors.title && <p id="maintenance-title-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.title}</p>}
        </div>
        <div>
          <label htmlFor="maintenance-description" className={labelClass}>Description (optional)</label>
          <Input id="maintenance-description" value={values.description} onChange={(event) => set("description", event.target.value)} />
        </div>
      </div>

      {/* Dependent scope picker (§14.2): target select appears only for
          client/monitor scopes; global never carries a scopeId. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="maintenance-scopeType" className={labelClass}>Scope</label>
          <select
            id="maintenance-scopeType"
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            value={values.scopeType}
            onChange={(event) => {
              const scopeType = event.target.value as MaintenanceScopeType;
              setValues((current) => ({ ...current, scopeType, scopeId: "" }));
            }}
          >
            {MAINTENANCE_SCOPE_TYPES.map((scopeType) => (
              <option key={scopeType} value={scopeType}>{scopeType === "global" ? "Global (everything)" : scopeType === "client" ? "One client" : "One monitor"}</option>
            ))}
          </select>
        </div>
        {values.scopeType !== "global" && (
          <div>
            <label htmlFor="maintenance-scopeId" className={labelClass}>{values.scopeType === "client" ? "Client" : "Monitor"}</label>
            <select
              id="maintenance-scopeId"
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              value={values.scopeId}
              aria-invalid={errors.scopeId ? true : undefined}
              aria-describedby={errors.scopeId ? "maintenance-scopeId-error" : undefined}
              onChange={(event) => set("scopeId", event.target.value)}
            >
              <option value="">Select a {values.scopeType}…</option>
              {(values.scopeType === "client" ? clients.map((client) => ({ id: client.id, label: client.name })) : monitors.map((monitor) => ({ id: monitor.id, label: monitor.name })))
                .map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
            </select>
            {errors.scopeId && <p id="maintenance-scopeId-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.scopeId}</p>}
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="maintenance-startsAt" className={labelClass}>Starts at (display timezone, stored UTC)</label>
          <Input
            id="maintenance-startsAt"
            type="datetime-local"
            value={values.startsAtWall}
            aria-invalid={errors.startsAt ? true : undefined}
            aria-describedby={errors.startsAt ? "maintenance-startsAt-error" : undefined}
            onChange={(event) => set("startsAtWall", event.target.value)}
          />
          {errors.startsAt && <p id="maintenance-startsAt-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.startsAt}</p>}
        </div>
        <div>
          <label htmlFor="maintenance-endsAt" className={labelClass}>Ends at (must be after start)</label>
          <Input
            id="maintenance-endsAt"
            type="datetime-local"
            value={values.endsAtWall}
            aria-invalid={errors.endsAt ? true : undefined}
            aria-describedby={errors.endsAt ? "maintenance-endsAt-error" : undefined}
            onChange={(event) => set("endsAtWall", event.target.value)}
          />
          {errors.endsAt && <p id="maintenance-endsAt-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.endsAt}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function MaintenancePage() {
  const queryClient = useQueryClient();
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const windowsQuery = useQuery({
    queryKey: ["maintenance"],
    queryFn: () => apiRequest<MaintenanceWindowDto[]>("/api/maintenance"),
    refetchInterval: 30_000,
  });
  const clientsQuery = useQuery({ queryKey: ["clients"], queryFn: () => apiRequest<ClientDto[]>("/api/clients") });
  const monitorsQuery = useQuery({ queryKey: ["monitors", false], queryFn: () => apiRequest<MonitorDto[]>("/api/monitors?includeArchived=false") });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["maintenance"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const saveMutation = useMutation({
    mutationFn: (input: { mode: "create" | "edit"; id?: string; body: unknown }) =>
      input.mode === "create"
        ? apiMutate<MaintenanceWindowDto>("/api/maintenance", "POST", input.body)
        : apiMutate<MaintenanceWindowDto>(`/api/maintenance/${input.id}`, "PATCH", input.body),
  });

  const cancelMutation = useMutation({
    mutationFn: (window: MaintenanceWindowDto) => apiMutate<MaintenanceWindowDto>(`/api/maintenance/${window.id}`, "DELETE"),
    onSuccess: async (cancelled) => {
      setConfirmCancelId(null);
      setNotice({ kind: "success", text: `Window "${cancelled.title}" cancelled. It never re-activates; the row is preserved.` });
      await invalidate();
    },
    onError: (error) =>
      setNotice({
        kind: "error",
        text: `Cancel failed (API category: ${error instanceof UptimeApiError ? error.category : "internal"}).`,
        requestId: error instanceof UptimeApiError ? error.requestId : null,
      }),
  });

  const windowsData = windowsQuery.data;
  // "Now" anchors to the fetch time — stable during render, refreshed by
  // each refetch (a Date.now() call during render would be impure).
  const nowMs = windowsQuery.dataUpdatedAt;
  const sections = useMemo(() => {
    const grouped: Record<string, MaintenanceWindowDto[]> = { active: [], upcoming: [], past: [], cancelled: [] };
    for (const window of windowsData ?? []) grouped[lifecycle(window, nowMs)].push(window);
    return grouped;
  }, [windowsData, nowMs]);

  async function handleSubmit(input: MaintenanceWindowInput) {
    if (formTarget?.mode === "edit") {
      await saveMutation.mutateAsync({ mode: "edit", id: formTarget.window.id, body: input });
      setNotice({ kind: "success", text: `Window "${input.title}" updated.` });
    } else {
      await saveMutation.mutateAsync({ mode: "create", body: input });
      setNotice({ kind: "success", text: `Window "${input.title}" created for ${formatTimestamp(input.startsAt)} (display time).` });
    }
    setFormTarget(null);
    await invalidate();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Maintenance</h1>
        <Button onClick={() => setFormTarget(formTarget === null ? { key: "create", mode: "create" } : null)}>
          {formTarget === null ? <Plus className="h-4 w-4" aria-hidden="true" /> : <X className="h-4 w-4" aria-hidden="true" />}
          {formTarget === null ? "New window" : "Close form"}
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Times are entered and shown in <span className="font-medium">Atlantic/Cape_Verde</span> and stored as UTC (§27.8).
      </p>

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

      {formTarget && (
        <Card>
          <CardHeader>
            <CardTitle>{formTarget.mode === "create" ? "New maintenance window" : `Edit "${formTarget.window.title}"`}</CardTitle>
          </CardHeader>
          <CardContent>
            <MaintenanceForm
              key={formTarget.key}
              mode={formTarget.mode}
              window={formTarget.mode === "edit" ? formTarget.window : undefined}
              clients={clientsQuery.data ?? []}
              monitors={monitorsQuery.data ?? []}
              submitLabel={formTarget.mode === "create" ? "Create window" : "Save changes"}
              onSubmit={handleSubmit}
              onCancel={() => setFormTarget(null)}
            />
          </CardContent>
        </Card>
      )}

      {windowsQuery.isPending && (
        <div aria-busy="true" aria-label="Loading maintenance windows">
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {windowsQuery.isError && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
              Maintenance windows unavailable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void windowsQuery.refetch()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {windowsQuery.isSuccess &&
        LIFECYCLE_SECTIONS.map((section) => {
          const sectionWindows = sections[section.key];
          return (
            <Card key={section.key}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {section.key === "active" && <Wrench className="h-4 w-4" aria-hidden="true" />}
                  {section.title}
                  <span className="text-sm font-normal text-muted-foreground">({sectionWindows.length})</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-xs text-muted-foreground">{section.hint}</p>
                {sectionWindows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No {section.key} windows.</p>
                ) : (
                  <ul className="space-y-3">
                    {sectionWindows.map((window) => (
                      <li key={window.id} className="rounded-md border p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="font-medium">
                              {window.title}
                              <Badge variant={section.key === "active" ? "info" : "neutral"} className="ml-2 font-mono">
                                {section.key.toUpperCase()}
                              </Badge>
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {scopeLabel(window, clientsQuery.data ?? [], monitorsQuery.data ?? [])}
                              {window.description ? ` · ${window.description}` : null}
                            </p>
                            <p className="mt-1 text-sm">
                              <time dateTime={window.startsAt} title={window.startsAt}>{formatTimestamp(window.startsAt)}</time>
                              {" → "}
                              <time dateTime={window.endsAt} title={window.endsAt}>{formatTimestamp(window.endsAt)}</time>
                              <span className="ml-2 text-xs text-muted-foreground">
                                ({formatDuration(Math.max(0, Date.parse(window.endsAt) - Date.parse(window.startsAt)))})
                              </span>
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {section.key !== "cancelled" && (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setFormTarget({ key: `edit-${window.id}`, mode: "edit", window })}
                                >
                                  Edit
                                </Button>
                                {confirmCancelId === window.id ? (
                                  <span className="inline-flex items-center gap-1">
                                    <span className="text-xs text-muted-foreground">Cancel this window?</span>
                                    <Button
                                      variant="destructive"
                                      size="sm"
                                      disabled={cancelMutation.isPending}
                                      onClick={() => cancelMutation.mutate(window)}
                                    >
                                      Confirm cancel
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={() => setConfirmCancelId(null)}>
                                      Keep
                                    </Button>
                                  </span>
                                ) : (
                                  <Button variant="ghost" size="sm" onClick={() => setConfirmCancelId(window.id)}>
                                    Cancel window
                                  </Button>
                                )}
                              </>
                            )}
                            {section.key === "cancelled" && (
                              <span className="text-xs text-muted-foreground">Read-only — cancelled windows never re-activate.</span>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}
    </div>
  );
}
