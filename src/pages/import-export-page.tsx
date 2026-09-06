/**
 * Import/Export page (issue #27; PRD §25, §27.2): paste/upload canonical
 * JSON, see per-row validation outcomes (created / duplicate / failed with
 * index + reasons), and download the secret-free export. Round-trip law:
 * export → import is idempotent (duplicates flagged, not duplicated).
 */
import { useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, FileUp, Loader2, Upload } from "lucide-react";
import { apiRequestEnvelope, UptimeApiError } from "../lib/api";
import type { ExportMonitorRow, ImportResultDto } from "../types/monitor-import";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

interface Notice {
  kind: "success" | "warning" | "error";
  text: string;
  requestId?: string | null;
}

/** sent-style badge vocabulary; never color alone. */
function RowStatusBadge({ status }: { status: "created" | "duplicate" | "failed" }) {
  const map = {
    created: { variant: "success" as const, label: "CREATED" },
    duplicate: { variant: "warning" as const, label: "DUPLICATE" },
    failed: { variant: "danger" as const, label: "FAILED" },
  };
  const style = map[status];
  return <Badge variant={style.variant} className="font-mono">{style.label}</Badge>;
}

export function ImportExportPage() {
  const queryClient = useQueryClient();
  const [rawJson, setRawJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<Notice | null>(null);
  const [result, setResult] = useState<ImportResultDto | null>(null);
  const [exporting, setExporting] = useState(false);

  async function runImport() {
    const text = rawJson.trim();
    if (text === "") {
      setError({ kind: "error", text: "Paste or upload a JSON file first." });
      return;
    }
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      // The raw text IS the request body: a malformed file must surface the
      // server's §38 validation envelope (AC: malformed JSON rejected).
      const envelope = await apiRequestEnvelope<ImportResultDto>("/api/monitors/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      setResult(envelope.data);
      void queryClient.invalidateQueries({ queryKey: ["monitors"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (cause) {
      if (cause instanceof UptimeApiError) {
        setError({
          kind: "error",
          text: `Import rejected (API category: ${cause.category}). ${cause.message}`,
          requestId: cause.requestId,
        });
      } else {
        setError({ kind: "error", text: cause instanceof Error ? cause.message : "import failed" });
      }
    } finally {
      setImporting(false);
    }
  }

  async function onFileChosen(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    try {
      setRawJson(await file.text());
      setError(null);
    } catch (cause) {
      setError({ kind: "error", text: `Could not read ${file.name}: ${cause instanceof Error ? cause.message : "unreadable file"}` });
    }
  }

  async function runExport() {
    setExporting(true);
    setError(null);
    try {
      const envelope = await apiRequestEnvelope<ExportMonitorRow[]>("/api/monitors/export");
      const blob = new Blob([JSON.stringify(envelope.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `morabeza-monitors-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setError({
        kind: envelope.data.length === 0 ? "warning" : "success",
        text:
          envelope.data.length === 0
            ? "Export produced no rows — there are no non-archived monitors yet."
            : `Exported ${envelope.data.length} monitor config row(s) as JSON.`,
      });
    } catch (cause) {
      setError(actionError("Export failed", cause));
    } finally {
      setExporting(false);
    }
  }

  function actionError(prefix: string, cause: unknown): Notice {
    return {
      kind: "error",
      text: `${prefix} (API category: ${cause instanceof UptimeApiError ? cause.category : "internal"}).`,
      requestId: cause instanceof UptimeApiError ? cause.requestId : null,
    };
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Import / Export</h1>

      <p className="text-sm text-muted-foreground">
        Canonical JSON per PRD §25.1 — clients are referenced by name. Import validates the whole file first:
        valid rows are created, probable duplicates are flagged and skipped (export → import is idempotent),
        invalid rows are reported with their index. The scheduler picks created monitors up naturally.
      </p>

      {error && (
        <div
          role={error.kind === "error" ? "alert" : "status"}
          className={
            error.kind === "error"
              ? "flex items-start justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm"
              : error.kind === "warning"
                ? "flex items-start justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
                : "flex items-start justify-between gap-2 rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm"
          }
        >
          <span>
            {error.text}
            {error.requestId ? ` Correlation id: ${error.requestId}` : null}
          </span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileUp className="h-4 w-4" aria-hidden="true" />
              Import monitors
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label htmlFor="import-file" className="mb-1 block text-xs font-medium text-muted-foreground">
                Upload a .json file (or paste below)
              </label>
              <input
                id="import-file"
                type="file"
                accept=".json,application/json"
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
                onChange={(event) => void onFileChosen(event.target.files?.[0])}
              />
              {fileName && <p className="mt-1 text-xs text-muted-foreground">Loaded {fileName}.</p>}
            </div>
            <div>
              <label htmlFor="import-json" className="mb-1 block text-xs font-medium text-muted-foreground">
                JSON rows (canonical §25.1 shape)
              </label>
              <textarea
                id="import-json"
                className="min-h-40 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
                placeholder={'[\n  {\n    "client": "Morabeza",\n    "name": "Contabilistas.cv Homepage",\n    "url": "https://contabilistas.cv/"\n  }\n]'}
                value={rawJson}
                onChange={(event) => setRawJson(event.target.value)}
                spellCheck={false}
              />
            </div>
            <Button disabled={importing} onClick={() => void runImport()}>
              {importing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <Upload className="h-4 w-4" aria-hidden="true" />
              Validate &amp; import
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="h-4 w-4" aria-hidden="true" />
              Export monitors
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Downloads every non-archived monitor as canonical JSON — the same shape the importer accepts,
              with headers sanitized per §10.9. Use it as a backup or to move configuration between environments.
            </p>
            <Button variant="outline" disabled={exporting} onClick={() => void runExport()}>
              {exporting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              <Download className="h-4 w-4" aria-hidden="true" />
              Download JSON
            </Button>
          </CardContent>
        </Card>
      </div>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>
              Import results — {result.summary.created} created, {result.summary.duplicates} duplicate
              {result.summary.duplicates === 1 ? "" : "s"}, {result.summary.failed} failed of {result.summary.total}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Per-row import outcomes with file index and reasons</caption>
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th scope="col" className="py-2 pr-3">Row</th>
                    <th scope="col" className="py-2 pr-3">Outcome</th>
                    <th scope="col" className="py-2 pr-3">Name</th>
                    <th scope="col" className="py-2">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((row) => (
                    <tr key={row.index} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-3 font-mono">#{row.index}</td>
                      <td className="py-2 pr-3"><RowStatusBadge status={row.status} /></td>
                      <td className="py-2 pr-3">{row.name ?? "—"}</td>
                      <td className="py-2 max-w-96">
                        {row.status === "created" && row.monitorId ? (
                          <Link to={`/monitors/${row.monitorId}`} className="underline underline-offset-2">
                            View monitor
                          </Link>
                        ) : row.status === "duplicate" && row.existingMonitorId ? (
                          <>
                            {row.errors?.[0]?.message ?? "probable duplicate"} ·{" "}
                            <Link to={`/monitors/${row.existingMonitorId}`} className="underline underline-offset-2">
                              existing monitor
                            </Link>
                          </>
                        ) : (
                          <ul className="list-inside list-disc font-mono text-xs text-red-600 dark:text-red-400">
                            {(row.errors ?? []).map((detail) => (
                              <li key={`${row.index}-${detail.path}-${detail.message}`}>
                                {detail.path}: {detail.message}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(result.summary.failed > 0 || result.summary.duplicates > 0) && (
              <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Valid rows were committed; fix the failed rows and re-import — duplicates stay flagged, not duplicated.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
