/**
 * Maintenance window form logic (issue #25; PRD §14, §27.8).
 *
 * The SAME Zod schemas the API enforces (worker/lib/maintenance-schema.ts)
 * run client-side; wall-clock inputs are converted to ms-precision UTC in
 * the §27.8 display timezone before validation. Pure, node-testable.
 */
import {
  createMaintenanceSchema,
  findMaintenanceConflicts,
  MAINTENANCE_SCOPE_TYPES,
} from "../../worker/lib/maintenance-schema";
import { wallInputToUtcIso } from "./datetime-local";
import type { MaintenanceWindowDto, MaintenanceScopeType } from "../types/monitor-detail";

export { MAINTENANCE_SCOPE_TYPES };

/** Form state: times as datetime-local wall strings in the display zone. */
export interface MaintenanceFormValues {
  title: string;
  description: string;
  scopeType: MaintenanceScopeType;
  scopeId: string;
  startsAtWall: string;
  endsAtWall: string;
}

export function emptyMaintenanceFormValues(): MaintenanceFormValues {
  return {
    title: "",
    description: "",
    scopeType: "global",
    scopeId: "",
    startsAtWall: "",
    endsAtWall: "",
  };
}

/** Edit prefill: persisted UTC → display-zone wall time (§27.8 −1h default). */
export function windowToFormValues(window: MaintenanceWindowDto, utcToWallInput: (iso: string) => string): MaintenanceFormValues {
  return {
    title: window.title,
    description: window.description ?? "",
    scopeType: window.scopeType,
    scopeId: window.scopeId ?? "",
    startsAtWall: utcToWallInput(window.startsAt),
    endsAtWall: utcToWallInput(window.endsAt),
  };
}

export interface MaintenanceWindowInput {
  title: string;
  description: string | null;
  scopeType: MaintenanceScopeType;
  scopeId: string | null;
  startsAt: string;
  endsAt: string;
}

export type MaintenanceFormValidation =
  | { ok: true; input: MaintenanceWindowInput }
  | { ok: false; errors: Record<string, string> };

/**
 * Converts wall inputs to UTC and validates via the shared API schema
 * (§14.2 scope rules + ends>starts). Server validation remains authoritative.
 */
export function validateMaintenanceForm(values: MaintenanceFormValues): MaintenanceFormValidation {
  const errors: Record<string, string> = {};

  const startsAt = wallInputToUtcIso(values.startsAtWall);
  if (startsAt === null) errors.startsAt = "enter a valid start date and time";
  const endsAt = wallInputToUtcIso(values.endsAtWall);
  if (endsAt === null) errors.endsAt = "enter a valid end date and time";

  const scopeId = values.scopeType === "global" ? null : values.scopeId.trim() === "" ? null : values.scopeId.trim();

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const input: MaintenanceWindowInput = {
    title: values.title,
    description: values.description.trim() === "" ? null : values.description.trim(),
    scopeType: values.scopeType,
    scopeId,
    startsAt: startsAt as string,
    endsAt: endsAt as string,
  };

  // Post-update consistency rules (create schema covers these on create).
  const conflict = findMaintenanceConflicts(input);
  if (conflict) {
    errors[conflict.path] = conflict.message;
    return { ok: false, errors };
  }

  const result = createMaintenanceSchema.safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = typeof issue.path[0] === "string" ? issue.path[0] : "form";
      if (errors[field] === undefined) errors[field] = issue.message;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, input };
}
