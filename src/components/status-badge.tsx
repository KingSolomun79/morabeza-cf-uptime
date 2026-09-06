/**
 * Shared status vocabulary (issue #21; PRD §27): the FIVE canonical monitor
 * states rendered as color + text + icon — never color alone (a11y law).
 */
import { CircleCheck, CircleHelp, CircleX, Pause, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge, type BadgeProps } from "./ui/badge";
import { cn } from "../lib/utils";

export const MONITOR_STATUSES = ["up", "down", "unknown", "paused", "maintenance"] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

interface StatusStyle {
  label: string;
  icon: LucideIcon;
  variant: BadgeProps["variant"];
  /** Extra emphasis for the icon; the badge variant carries the color. */
  iconClassName?: string;
}

const STATUS_STYLES: Record<MonitorStatus, StatusStyle> = {
  up: { label: "UP", icon: CircleCheck, variant: "success" },
  down: { label: "DOWN", icon: CircleX, variant: "danger" },
  unknown: { label: "UNKNOWN", icon: CircleHelp, variant: "neutral" },
  paused: { label: "PAUSED", icon: Pause, variant: "warning" },
  maintenance: { label: "MAINTENANCE", icon: Wrench, variant: "info" },
};

export function isMonitorStatus(value: string): value is MonitorStatus {
  return (MONITOR_STATUSES as readonly string[]).includes(value);
}

export interface StatusBadgeProps {
  status: MonitorStatus;
  /** Optional extra context for assistive tech / hover (e.g. "since 12:04"). */
  note?: string;
  className?: string;
}

export function StatusBadge({ status, note, className }: StatusBadgeProps) {
  const style = STATUS_STYLES[status];
  const Icon = style.icon;
  return (
    <Badge variant={style.variant} className={cn("font-mono", className)} title={note ?? style.label}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {/* The text label is the accessible name — color is supplementary. */}
      <span>{style.label}</span>
    </Badge>
  );
}
