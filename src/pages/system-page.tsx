/**
 * System page (issue #26; PRD §27.10): renders GET /api/system — heartbeat
 * cards with obvious FRESH/STALE/NEVER RAN indicators under the shared #11
 * law, effective retention policy, last rollup/cleanup times, the Email
 * Service test action (#17), and the dead-letter ops list with
 * resolve-with-notes. Secret hygiene (§27.10): operator facts only — no
 * account ids, tokens, or binding names are rendered.
 */
import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CircleCheck, CircleHelp, CircleX, RefreshCw, Send } from "lucide-react";
import { apiMutate, apiRequest, apiRequestEnvelope, UptimeApiError } from "../lib/api";
import { formatRelative, formatTimestamp } from "../lib/time-format";
import type { DeadLetterDto, HeartbeatView, SystemReportDto } from "../types/system";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";

const DEAD_LETTERS_PAGE_SIZE = 25;

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

/** Never color alone: each state carries icon + text (a11y law). */
function HeartbeatIndicator({ status }: { status: HeartbeatView["status"] }) {
  if (status === "stale") {
    return (
      <Badge variant="danger" className="font-mono" title="The last heartbeat is older than the freshness limit">
        <CircleX className="h-3.5 w-3.5" aria-hidden="true" />
        STALE
      </Badge>
    );
  }
  if (status === "never_run") {
    return (
      <Badge variant="neutral" className="font-mono" title="No heartbeat yet (bootstrap grace, §19)">
        <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
        NEVER RAN
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="font-mono">
      <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
      FRESH
    </Badge>
  );
}

function HeartbeatRow({ label, view }: { label: string; view: HeartbeatView }) {
  return (
    <li className="flex items-center justify-between gap-2 py-1.5">
      <span className="text-sm">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground" title={view.at ? formatTimestamp(view.at) : undefined}>
          {view.at ? formatRelative(view.at) : "—"}
        </span>
        <HeartbeatIndicator status={view.status} />
      </span>
    </li>
  );
}

/** Resolve flow: armed per row; notes are optional but encouraged. */
function ResolveRow({ letter, onResolved }: { letter: DeadLetterDto; onResolved: (notice: Notice) => void }) {
  const [armed, setArmed] = useState(false);
  const [notes, setNotes] = useState("");
  const resolve = useMutation({
    mutationFn: (id: string) =>
      apiMutate<DeadLetterDto>(`/api/dead-letters/${id}`, "PATCH", { notes: notes.trim() === "" ? null : notes.trim() }),
  });

  if (!armed) {
    return (
      <Button variant="outline" size="sm" onClick={() => setArmed(true)}>
        Resolve
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      <label className="sr-only" htmlFor={`notes-${letter.id}`}>Resolution notes</label>
      <Input
        id={`notes-${letter.id}`}
        placeholder="Resolution notes (optional)"
        className="h-8 max-w-56"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />
      <Button
        variant="destructive"
        size="sm"
        disabled={resolve.isPending}
        onClick={async () => {
          try {
            const envelope = await apiRequestEnvelope<DeadLetterDto>(`/api/dead-letters/${letter.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ notes: notes.trim() === "" ? null : notes.trim() }),
            });
            onResolved({
              kind: envelope.warning ? "warning" : "success",
              text: envelope.warning ? `Dead letter ${letter.id}: ${envelope.warning}.` : `Dead letter ${letter.id} resolved.`,
            });
            setArmed(false);
          } catch (cause) {
            onResolved(actionError("Resolve failed", cause));
          }
        }}
      >
        Confirm resolve
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
        Keep
      </Button>
    </span>
  );
}

export function SystemPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deadLetterFilter, setDeadLetterFilter] = useState<"unresolved" | "resolved" | "all">("unresolved");
  const [deadLettersPage, setDeadLettersPage] = useState(1);
  const [testTargetId, setTestTargetId] = useState("");
  const [sendingTest, setSendingTest] = useState(false);

  const systemQuery = useQuery({
    queryKey: ["system"],
    queryFn: () => apiRequest<SystemReportDto>("/api/system"),
    refetchInterval: 15_000,
  });
  const targetsQuery = useQuery({
    queryKey: ["notification-targets"],
    queryFn: () => apiRequest<Array<{ id: string; name: string; email: string; enabled: boolean; isDefault: boolean }>>("/api/notification-targets"),
  });
  const deadLettersQuery = useQuery({
    queryKey: ["dead-letters", deadLetterFilter, deadLettersPage],
    queryFn: () =>
      apiRequestEnvelope<DeadLetterDto[]>(
        `/api/dead-letters?filter=${deadLetterFilter}&limit=${DEAD_LETTERS_PAGE_SIZE}&offset=${(deadLettersPage - 1) * DEAD_LETTERS_PAGE_SIZE}`,
      ),
    refetchInterval: 30_000,
  });

  async function sendTestEmail() {
    if (testTargetId === "") return;
    setSendingTest(true);
    try {
      const envelope = await apiRequestEnvelope<{ notificationEventId: string }>(`/api/notification-targets/${testTargetId}/test`, { method: "POST" });
      setNotice({
        kind: "success",
        text: `Test email queued (event ${envelope.data.notificationEventId}). Its outcome appears in the delivery log on the Notifications page.`,
      });
    } catch (cause) {
      setNotice(actionError("Send test email failed", cause));
    } finally {
      setSendingTest(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">System</h1>
        {systemQuery.isSuccess && (
          <Badge variant={systemQuery.data.d1.reachable ? "success" : "danger"} className="font-mono">
            D1 {systemQuery.data.d1.reachable ? "REACHABLE" : "UNREACHABLE"}
          </Badge>
        )}
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
            ×
          </button>
        </div>
      )}

      {systemQuery.isPending && (
        <div aria-busy="true" aria-label="Loading system report"><Skeleton className="h-48 w-full" /></div>
      )}

      {systemQuery.isError && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
              System report unavailable
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{actionError("The system report could not be loaded", systemQuery.error).text}</p>
            <Button variant="outline" onClick={() => void systemQuery.refetch()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {systemQuery.isSuccess && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Heartbeats (§27.10) — freshness law shared with /healthz */}
            <Card>
              <CardHeader><CardTitle>Heartbeats</CardTitle></CardHeader>
              <CardContent>
                <ul className="divide-y">
                  <HeartbeatRow label="Scheduler (cron)" view={systemQuery.data.heartbeats.scheduler} />
                  <HeartbeatRow label="Queue consumer" view={systemQuery.data.heartbeats.queueConsumer} />
                  <HeartbeatRow label="Hourly rollup" view={systemQuery.data.heartbeats.hourlyRollup} />
                  <HeartbeatRow label="Daily rollup" view={systemQuery.data.heartbeats.dailyRollup} />
                  <HeartbeatRow label="Retention cleanup" view={systemQuery.data.heartbeats.cleanup} />
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  Stale = the component ran and stopped (never-run is bootstrap grace, §19). Same law as /healthz.
                </p>
              </CardContent>
            </Card>

            <div className="space-y-4">
              {/* Retention policy (§27.10) */}
              <Card>
                <CardHeader><CardTitle>Retention policy</CardTitle></CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">Raw checks</dt>
                      <dd className="font-mono">{systemQuery.data.retention.rawCheckDays}d</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Hourly rollups</dt>
                      <dd className="font-mono">{systemQuery.data.retention.hourlyDays}d</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Daily rollups</dt>
                      <dd className="font-mono">{systemQuery.data.retention.dailyDays}d</dd>
                    </div>
                  </dl>
                  <p className="mt-2 text-xs text-muted-foreground">
                    scheduler_runs: fixed 7d · resolved dead letters: 30d ·
                    {systemQuery.data.version ? ` version ${systemQuery.data.version} · ` : " version unset (pre-provisioning) · "}
                    email {systemQuery.data.emailConfigured ? "configured" : "not configured"}
                  </p>
                </CardContent>
              </Card>

              {/* Email Service test action (#17) — §27.10 */}
              <Card>
                <CardHeader><CardTitle>Email test</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  <label htmlFor="system-test-target" className="block text-xs font-medium text-muted-foreground">Send a test email through the delivery pipeline</label>
                  <div className="flex items-center gap-2">
                    <select
                      id="system-test-target"
                      className="h-9 max-w-64 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
                      value={testTargetId}
                      onChange={(event) => setTestTargetId(event.target.value)}
                    >
                      <option value="">Select a target…</option>
                      {(targetsQuery.data ?? []).filter((target) => target.enabled).map((target) => (
                        <option key={target.id} value={target.id}>{target.name} ({target.email})</option>
                      ))}
                    </select>
                    <Button disabled={testTargetId === "" || sendingTest} onClick={() => void sendTestEmail()}>
                      {sendingTest ? "Queuing…" : (
                        <>
                          <Send className="h-4 w-4" aria-hidden="true" />
                          Send test
                        </>
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Queued through the same pipeline as alerts — never sent inline. Outcome lands in the{" "}
                    <Link to="/notifications" className="underline underline-offset-2">delivery log</Link>.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Dead-letter ops (§27.10, §24) */}
          <Card>
            <CardHeader>
              <CardTitle>
                Dead letters
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {systemQuery.data.deadLetters.unresolved} unresolved
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="dlq-filter">Filter dead letters</label>
                <select
                  id="dlq-filter"
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={deadLetterFilter}
                  onChange={(event) => {
                    setDeadLetterFilter(event.target.value as "unresolved" | "resolved" | "all");
                    setDeadLettersPage(1);
                  }}
                >
                  <option value="unresolved">Unresolved</option>
                  <option value="resolved">Resolved</option>
                  <option value="all">All</option>
                </select>
              </div>

              {deadLettersQuery.isPending ? (
                <Skeleton className="h-40 w-full" />
              ) : deadLettersQuery.isError ? (
                <p className="text-sm text-destructive">{actionError("Dead-letter list unavailable", deadLettersQuery.error).text}</p>
              ) : deadLettersQuery.data.data.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {deadLetterFilter === "unresolved" ? "No unresolved dead letters — the DLQ is quiet." : "No dead letters match this filter."}
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="sr-only">Dead-letter events with failure reason and resolution controls</caption>
                      <thead>
                        <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th scope="col" className="py-2 pr-3">Received</th>
                          <th scope="col" className="py-2 pr-3">Type</th>
                          <th scope="col" className="py-2 pr-3">Job</th>
                          <th scope="col" className="py-2 pr-3">Failure</th>
                          <th scope="col" className="py-2">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deadLettersQuery.data.data.map((letter) => (
                          <tr key={letter.id} className="border-b last:border-0 align-top">
                            <td className="py-2 pr-3">
                              <time dateTime={letter.receivedAt} title={formatTimestamp(letter.receivedAt)}>{formatRelative(letter.receivedAt)}</time>
                            </td>
                            <td className="py-2 pr-3 font-mono text-xs">{letter.messageType ?? "—"}</td>
                            <td className="py-2 pr-3 font-mono text-xs">{letter.originalJobId ?? "—"}</td>
                            <td className="py-2 pr-3 max-w-64">
                              <span className="block truncate" title={letter.failureReason ?? undefined}>{letter.failureReason ?? "—"}</span>
                              {letter.resolvedAt && (
                                <Badge variant="success" className="mt-1 font-mono">RESOLVED</Badge>
                              )}
                            </td>
                            <td className="py-2">
                              {letter.resolvedAt ? (
                                <span className="text-xs text-muted-foreground" title={letter.resolutionNotes ?? undefined}>
                                  {letter.resolutionNotes ?? "resolved"}
                                </span>
                              ) : (
                                <ResolveRow
                                  letter={letter}
                                  onResolved={(resolvedNotice) => {
                                    setNotice(resolvedNotice);
                                    void queryClient.invalidateQueries({ queryKey: ["dead-letters"] });
                                    void queryClient.invalidateQueries({ queryKey: ["system"] });
                                  }}
                                />
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>Page {deadLettersPage}</span>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" disabled={deadLettersPage <= 1} onClick={() => setDeadLettersPage((current) => Math.max(1, current - 1))}>
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={deadLettersPage * DEAD_LETTERS_PAGE_SIZE >= (deadLettersQuery.data.pagination?.total ?? 0)}
                        onClick={() => setDeadLettersPage((current) => current + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
