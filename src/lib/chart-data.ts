/**
 * Monitor detail chart shaping (issue #24; PRD §27.5). Pure functions:
 * checks → response-time points, maintenance windows → overlay regions for
 * the chart's range. Overlays are matched by §14.2 scope rules against the
 * rendered window and never include cancelled windows.
 */
import type { CheckDto, MaintenanceWindowDto } from "../types/monitor-detail";

export interface ResponseTimePoint {
  /** Preformatted label (display timezone) used as the category tick. */
  label: string;
  ms: number;
  /** Persisted timestamp, kept for maintenance-overlap computation. */
  at: string;
}

/** Plots every check that carries a response time, in chart (newest-last) order. */
export function checksToChartPoints(checks: CheckDto[], formatLabel: (iso: string) => string): ResponseTimePoint[] {
  return checks
    .filter((check) => check.responseTimeMs !== null)
    .slice()
    .sort((a, b) => (a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1 : 0))
    .map((check) => ({ label: formatLabel(check.completedAt), ms: check.responseTimeMs as number, at: check.completedAt }));
}

export interface MaintenanceOverlay {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
}

/**
 * Turns time-range overlays into category-axis regions. Maintenance checks
 * carry no response time, so a window often has NO plotted points inside it —
 * the region is therefore bracketed by the plotted points surrounding it
 * (last point at/before start → first point at/after end), which renders
 * correctly even when every check in the window was excluded.
 */
export interface ChartOverlayRegion {
  id: string;
  title: string;
  x1: string;
  x2: string;
}

export function overlayRegionsForPoints(overlays: MaintenanceOverlay[], points: ResponseTimePoint[]): ChartOverlayRegion[] {
  if (points.length === 0) return [];
  const regions: ChartOverlayRegion[] = [];
  for (const overlay of overlays) {
    // x1: the last plotted point at/before the window start (0 when the
    // window starts before every point).
    let x1Index = 0;
    for (let i = 0; i < points.length; i++) {
      if (points[i].at <= overlay.startsAt) x1Index = i;
    }
    // x2: the first plotted point at/after the window end (the last point
    // when the window ends beyond every point).
    let x2Index = points.length - 1;
    for (let i = 0; i < points.length; i++) {
      if (points[i].at >= overlay.endsAt) {
        x2Index = i;
        break;
      }
    }
    // Safety net for a window bracketed by a single point — widen right.
    if (x2Index <= x1Index) x2Index = Math.min(x1Index + 1, points.length - 1);
    regions.push({ id: overlay.id, title: overlay.title, x1: points[x1Index].label, x2: points[x2Index].label });
  }
  return regions;
}

function windowAppliesToMonitor(window: MaintenanceWindowDto, monitor: { id: string; clientId: string }): boolean {
  if (window.cancelledAt !== null) return false;
  if (window.scopeType === "global") return true;
  if (window.scopeType === "client") return window.scopeId === monitor.clientId;
  return window.scopeType === "monitor" && window.scopeId === monitor.id;
}

/**
 * §14.2 scope matching + half-open [start, end) overlap with the chart's
 * [rangeStart, rangeEnd) window. Lexicographic ISO comparisons, as everywhere
 * else timestamps are compared in this codebase.
 */
export function maintenanceOverlaysForChart(
  windows: MaintenanceWindowDto[],
  monitor: { id: string; clientId: string },
  range: { start: string; end: string },
): MaintenanceOverlay[] {
  return windows
    .filter((window) => windowAppliesToMonitor(window, monitor))
    .filter((window) => window.startsAt < range.end && window.endsAt > range.start)
    .map((window) => ({ id: window.id, title: window.title, startsAt: window.startsAt, endsAt: window.endsAt }))
    .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
}
