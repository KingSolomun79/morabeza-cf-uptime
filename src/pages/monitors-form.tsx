/**
 * Monitor create/edit form (issue #23; PRD §10, §22, §27.4).
 *
 * Validation is a client-side pre-flight of the SAME Zod schemas the API
 * enforces (src/lib/monitor-form.ts → worker/lib/monitor-schema.ts); server
 * validation remains authoritative and its `details` array maps back onto
 * the same fields. POST carries the §10.1 may-execute-twice warning.
 */
import { useState, type FormEvent } from "react";
import { AlertTriangle, Loader2, Plus, X } from "lucide-react";
import { UptimeApiError } from "../lib/api";
import {
  emptyMonitorFormValues,
  formValuesToConfigInput,
  INTERVAL_CHOICES,
  monitorToFormValues,
  POST_METHOD_WARNING,
  validateMonitorConfig,
  type HeaderRow,
  type MonitorConfigInput,
  type MonitorFormValues,
} from "../lib/monitor-form";
import type { ClientDto, MonitorDto } from "../types/monitor";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

const inputClass = "w-full";

/** Server-side §38 validation details map back onto the same field keys. */
function serverFieldErrors(error: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (error instanceof UptimeApiError && error.details) {
    for (const detail of error.details) {
      if (map[detail.path] === undefined) map[detail.path] = detail.message;
    }
  }
  return map;
}

export interface MonitorFormProps {
  clients: ClientDto[];
  /** create → blank defaults; edit/duplicate → prefilled from the monitor. */
  mode: "create" | "edit" | "duplicate";
  monitor?: MonitorDto;
  submitLabel: string;
  onSubmit: (input: MonitorConfigInput) => Promise<void>;
  onCancel: () => void;
}

export function MonitorForm({ clients, mode, monitor, submitLabel, onSubmit, onCancel }: MonitorFormProps) {
  const [values, setValues] = useState<MonitorFormValues>(() =>
    mode === "create" || !monitor ? emptyMonitorFormValues() : monitorToFormValues(monitor, mode),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<UptimeApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = <K extends keyof MonitorFormValues>(field: K, value: MonitorFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const setHeader = (index: number, patch: Partial<HeaderRow>) => {
    setValues((current) => ({
      ...current,
      headers: current.headers.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  };

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const validation = validateMonitorConfig(formValuesToConfigInput(values));
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
      if (cause instanceof UptimeApiError) {
        setServerError(cause);
        setErrors(serverFieldErrors(cause));
      } else {
        // Unexpected (non-API) failure — show it instead of dying silently.
        setServerError(
          new UptimeApiError("internal", cause instanceof Error ? cause.message : "unexpected submit failure"),
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  const labelClass = "mb-1 block text-xs font-medium text-muted-foreground";
  const described = (field: string) => (errors[field] ? `monitor-${field}-error` : undefined);

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4" aria-label="Monitor form" noValidate>
      {serverError && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <span className="font-medium">The API rejected the monitor ({serverError.category}).</span>{" "}
          {serverError.message}
          {serverError.requestId ? ` Correlation id: ${serverError.requestId}` : null}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="monitor-clientId" className={labelClass}>Client</label>
          <select
            id="monitor-clientId"
            className={`h-9 ${inputClass} rounded-md border border-input bg-transparent px-2 text-sm`}
            value={values.clientId}
            aria-invalid={errors.clientId ? true : undefined}
            aria-describedby={described("clientId")}
            onChange={(event) => set("clientId", event.target.value)}
          >
            <option value="">Select a client…</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>{client.name}</option>
            ))}
          </select>
          <FieldError id="monitor-clientId-error" message={errors.clientId} />
        </div>

        <div>
          <label htmlFor="monitor-name" className={labelClass}>Name</label>
          <Input
            id="monitor-name"
            className={inputClass}
            value={values.name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={described("name")}
            onChange={(event) => set("name", event.target.value)}
          />
          <FieldError id="monitor-name-error" message={errors.name} />
        </div>
      </div>

      <div>
        <label htmlFor="monitor-url" className={labelClass}>URL (public http(s) only)</label>
        <Input
          id="monitor-url"
          type="url"
          placeholder="https://example.com/health"
          className={inputClass}
          value={values.url}
          aria-invalid={errors.url ? true : undefined}
          aria-describedby={described("url")}
          onChange={(event) => set("url", event.target.value)}
        />
        <FieldError id="monitor-url-error" message={errors.url} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="monitor-method" className={labelClass}>Method</label>
          <select
            id="monitor-method"
            className={`h-9 ${inputClass} rounded-md border border-input bg-transparent px-2 text-sm`}
            value={values.method}
            onChange={(event) => {
              set("method", event.target.value);
              // A body is meaningless (and rejected) for GET/HEAD — dropping
              // it here keeps the error off a field that is about to unmount.
              if (event.target.value !== "POST") set("requestBody", "");
            }}
          >
            <option value="GET">GET</option>
            <option value="HEAD">HEAD</option>
            <option value="POST">POST</option>
          </select>
        </div>
        <div>
          <label htmlFor="monitor-intervalSeconds" className={labelClass}>Interval</label>
          <select
            id="monitor-intervalSeconds"
            className={`h-9 ${inputClass} rounded-md border border-input bg-transparent px-2 text-sm`}
            value={values.intervalSeconds}
            aria-invalid={errors.intervalSeconds ? true : undefined}
            aria-describedby={described("intervalSeconds")}
            onChange={(event) => set("intervalSeconds", event.target.value)}
          >
            {INTERVAL_CHOICES.map((seconds) => (
              <option key={seconds} value={String(seconds)}>{seconds} seconds</option>
            ))}
          </select>
          <FieldError id="monitor-intervalSeconds-error" message={errors.intervalSeconds} />
        </div>
        <div>
          <label htmlFor="monitor-expectedStatusCodes" className={labelClass}>Expected status codes</label>
          <Input
            id="monitor-expectedStatusCodes"
            className={inputClass}
            placeholder="200, 204"
            value={values.expectedStatusCodes}
            aria-invalid={errors.expectedStatusCodes ? true : undefined}
            aria-describedby={described("expectedStatusCodes")}
            onChange={(event) => set("expectedStatusCodes", event.target.value)}
          />
          <FieldError id="monitor-expectedStatusCodes-error" message={errors.expectedStatusCodes} />
        </div>
      </div>

      {values.method === "POST" && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" role="note">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span>{POST_METHOD_WARNING}</span>
        </div>
      )}

      {values.method === "POST" && (
        <div>
          <label htmlFor="monitor-requestBody" className={labelClass}>Request body (POST only)</label>
          <textarea
            id="monitor-requestBody"
            className={`${inputClass} min-h-20 rounded-md border border-input bg-transparent px-3 py-2 text-sm`}
            value={values.requestBody}
            aria-invalid={errors.requestBody ? true : undefined}
            aria-describedby={described("requestBody")}
            onChange={(event) => set("requestBody", event.target.value)}
          />
          <FieldError id="monitor-requestBody-error" message={errors.requestBody} />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="monitor-bodyContains" className={labelClass}>Body must contain (optional)</label>
          <Input
            id="monitor-bodyContains"
            className={inputClass}
            value={values.bodyContains}
            aria-invalid={errors.bodyContains ? true : undefined}
            aria-describedby={described("bodyContains")}
            onChange={(event) => set("bodyContains", event.target.value)}
          />
          <FieldError id="monitor-bodyContains-error" message={errors.bodyContains} />
        </div>
        <div>
          <label htmlFor="monitor-bodyNotContains" className={labelClass}>Body must NOT contain (optional)</label>
          <Input
            id="monitor-bodyNotContains"
            className={inputClass}
            value={values.bodyNotContains}
            aria-invalid={errors.bodyNotContains ? true : undefined}
            aria-describedby={described("bodyNotContains")}
            onChange={(event) => set("bodyNotContains", event.target.value)}
          />
          <FieldError id="monitor-bodyNotContains-error" message={errors.bodyNotContains} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div>
          <label htmlFor="monitor-maxResponseTimeMs" className={labelClass}>Max response (ms)</label>
          <Input
            id="monitor-maxResponseTimeMs"
            type="number"
            min={1}
            max={60000}
            className={inputClass}
            value={values.maxResponseTimeMs}
            aria-invalid={errors.maxResponseTimeMs ? true : undefined}
            aria-describedby={described("maxResponseTimeMs")}
            onChange={(event) => set("maxResponseTimeMs", event.target.value)}
          />
          <FieldError id="monitor-maxResponseTimeMs-error" message={errors.maxResponseTimeMs} />
        </div>
        <div>
          <label htmlFor="monitor-timeoutMs" className={labelClass}>Timeout (ms)</label>
          <Input
            id="monitor-timeoutMs"
            type="number"
            min={1000}
            max={60000}
            className={inputClass}
            value={values.timeoutMs}
            aria-invalid={errors.timeoutMs ? true : undefined}
            aria-describedby={described("timeoutMs")}
            onChange={(event) => set("timeoutMs", event.target.value)}
          />
          <FieldError id="monitor-timeoutMs-error" message={errors.timeoutMs} />
        </div>
        <div>
          <label htmlFor="monitor-failureThreshold" className={labelClass}>Failure threshold</label>
          <Input
            id="monitor-failureThreshold"
            type="number"
            min={1}
            max={10}
            className={inputClass}
            value={values.failureThreshold}
            aria-invalid={errors.failureThreshold ? true : undefined}
            aria-describedby={described("failureThreshold")}
            onChange={(event) => set("failureThreshold", event.target.value)}
          />
          <FieldError id="monitor-failureThreshold-error" message={errors.failureThreshold} />
        </div>
        <div>
          <label htmlFor="monitor-recoveryThreshold" className={labelClass}>Recovery threshold</label>
          <Input
            id="monitor-recoveryThreshold"
            type="number"
            min={1}
            max={10}
            className={inputClass}
            value={values.recoveryThreshold}
            aria-invalid={errors.recoveryThreshold ? true : undefined}
            aria-describedby={described("recoveryThreshold")}
            onChange={(event) => set("recoveryThreshold", event.target.value)}
          />
          <FieldError id="monitor-recoveryThreshold-error" message={errors.recoveryThreshold} />
        </div>
      </div>

      {/* Custom headers (PRD §10.9): non-sensitive names only; sensitive
          names are rejected inline and again by the API. */}
      <div className="space-y-2">
        <span className={labelClass}>Custom headers (optional, non-sensitive)</span>
        {values.headers.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <label className="sr-only" htmlFor={`monitor-header-name-${index}`}>Header name</label>
            <Input
              id={`monitor-header-name-${index}`}
              placeholder="Name"
              className="max-w-48"
              value={row.name}
              aria-invalid={errors.headers ? true : undefined}
              onChange={(event) => setHeader(index, { name: event.target.value })}
            />
            <label className="sr-only" htmlFor={`monitor-header-value-${index}`}>Header value</label>
            <Input
              id={`monitor-header-value-${index}`}
              placeholder="Value"
              className="max-w-64"
              value={row.value}
              onChange={(event) => setHeader(index, { value: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove header ${row.name || index + 1}`}
              onClick={() =>
                setValues((current) => ({
                  ...current,
                  headers: current.headers.filter((_, i) => i !== index),
                }))
              }
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
        <FieldError id="monitor-headers-error" message={errors.headers} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => set("headers", [...values.headers, { name: "", value: "" }])}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add header
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="monitor-tags" className={labelClass}>Tags (comma-separated, optional)</label>
          <Input
            id="monitor-tags"
            className={inputClass}
            value={values.tags}
            aria-invalid={errors.tags ? true : undefined}
            aria-describedby={described("tags")}
            onChange={(event) => set("tags", event.target.value)}
          />
          <FieldError id="monitor-tags-error" message={errors.tags} />
        </div>
        <div className="flex items-end pb-2">
          <span className="flex items-center gap-2 text-sm">
            <input
              id="monitor-cacheBust"
              type="checkbox"
              checked={values.cacheBust}
              onChange={(event) => set("cacheBust", event.target.checked)}
            />
            <label htmlFor="monitor-cacheBust">Cache-bust checks (PRD §10.7)</label>
          </span>
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
