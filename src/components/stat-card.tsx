/**
 * Stat card (issue #22; PRD §27.3): one headline number with a label.
 * Color conveys health but the label always carries the meaning.
 */
import type { ReactNode } from "react";
import { Card, CardContent } from "./ui/card";
import { cn } from "../lib/utils";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  /** Tailwind text color class for the value (semantic, optional). */
  valueClassName?: string;
}

export function StatCard({ label, value, valueClassName }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn("mt-1 text-2xl font-semibold", valueClassName)}>{value}</p>
      </CardContent>
    </Card>
  );
}
