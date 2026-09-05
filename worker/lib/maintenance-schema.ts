/**
 * Maintenance window create/update validation (issue #15; PRD §14, §24).
 *
 * Scope consistency (§14.2): `global` → no scope_id; `client`/`monitor` →
 * scope_id required (reference existence is checked against D1 in the
 * repository — this module is pure). Timestamps must be ms-precision UTC
 * ISO-8601: window matching and all other time comparisons in the check
 * pipeline are lexicographic on one uniform format (PRD §17 preamble).
 */
import { z } from "zod";

export const MAINTENANCE_SCOPE_TYPES = ["global", "client", "monitor"] as const;
export type MaintenanceScopeType = (typeof MAINTENANCE_SCOPE_TYPES)[number];

/** Strict ms-precision UTC ISO-8601 (`2026-09-05T12:00:00.000Z`). */
const utcIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "must be ms-precision UTC ISO-8601 (e.g. 2026-09-05T12:00:00.000Z)")
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be a valid date");

export const createMaintenanceSchema = z
  .object({
    title: z.string().trim().min(1, "title is required").max(200),
    description: z.string().max(2000).nullish(),
    scopeType: z.enum(MAINTENANCE_SCOPE_TYPES),
    scopeId: z.string().min(1).nullish(),
    startsAt: utcIso,
    endsAt: utcIso,
  })
  .superRefine((value, ctx) => {
    if (value.scopeType === "global" && value.scopeId) {
      ctx.addIssue({ code: "custom", path: ["scopeId"], message: "global windows must not carry a scopeId" });
    }
    if (value.scopeType !== "global" && !value.scopeId) {
      ctx.addIssue({ code: "custom", path: ["scopeId"], message: `${value.scopeType} windows require a scopeId` });
    }
    if (!Number.isNaN(Date.parse(value.startsAt)) && !Number.isNaN(Date.parse(value.endsAt)) && Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be after startsAt" });
    }
  });

export type CreateMaintenanceInput = z.output<typeof createMaintenanceSchema>;

export const updateMaintenanceSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).nullish(),
    scopeType: z.enum(MAINTENANCE_SCOPE_TYPES).optional(),
    scopeId: z.string().min(1).nullish(),
    startsAt: utcIso.optional(),
    endsAt: utcIso.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "at least one field to update is required");

export type UpdateMaintenanceInput = z.output<typeof updateMaintenanceSchema>;

/** Post-merge consistency check for partial updates (mirrors the create rules). */
export function findMaintenanceConflicts(input: {
  scopeType: MaintenanceScopeType;
  scopeId: string | null;
  startsAt: string;
  endsAt: string;
}): { path: string; message: string } | null {
  if (input.scopeType === "global" && input.scopeId) {
    return { path: "scopeId", message: "global windows must not carry a scopeId" };
  }
  if (input.scopeType !== "global" && !input.scopeId) {
    return { path: "scopeId", message: `${input.scopeType} windows require a scopeId` };
  }
  if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) {
    return { path: "endsAt", message: "endsAt must be after startsAt" };
  }
  return null;
}
