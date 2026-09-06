/**
 * Issue #25 — maintenance form logic (PRD §14, §27.8): the client-side
 * pre-flight MUST agree with the shared API schema (§14.2 scope rules,
 * ends > starts), and wall-clock inputs convert to ms-precision UTC.
 * Node environment: pure functions.
 */
import { describe, expect, it } from "vitest";
import {
  emptyMaintenanceFormValues,
  validateMaintenanceForm,
  windowToFormValues,
} from "../../src/lib/maintenance-form";
import { utcToWallInput } from "../../src/lib/datetime-local";
import type { MaintenanceWindowDto } from "../../src/types/monitor-detail";

function globalWindow() {
  return {
    ...emptyMaintenanceFormValues(),
    title: "Deploy",
    startsAtWall: "2026-09-05T10:00",
    endsAtWall: "2026-09-05T12:00",
  };
}

describe("validateMaintenanceForm (§14.2 + §27.8)", () => {
  it("converts wall inputs to ms-precision UTC with the −1h offset", () => {
    const validation = validateMaintenanceForm(globalWindow());
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.input.startsAt).toBe("2026-09-05T11:00:00.000Z");
      expect(validation.input.endsAt).toBe("2026-09-05T13:00:00.000Z");
      expect(validation.input.scopeId).toBeNull();
      expect(validation.input.description).toBeNull();
    }
  });

  it("requires valid wall times before anything else", () => {
    const validation = validateMaintenanceForm(emptyMaintenanceFormValues());
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.errors.startsAt).toMatch(/valid start/);
      expect(validation.errors.endsAt).toMatch(/valid end/);
    }
  });

  it("blocks ends ≤ starts client-side (the AC's client+server double gate)", () => {
    const values = globalWindow();
    values.endsAtWall = "2026-09-05T10:00"; // equal to start
    const validation = validateMaintenanceForm(values);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.endsAt).toMatch(/after startsAt/);

    values.endsAtWall = "2026-09-05T09:00"; // before start — also blocked
    const before = validateMaintenanceForm(values);
    expect(before.ok).toBe(false);
  });

  it("enforces §14.2: client/monitor windows require a scopeId; global clears any stray one", () => {
    const clientScope = globalWindow();
    clientScope.scopeType = "client";
    const missing = validateMaintenanceForm(clientScope);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.scopeId).toMatch(/require a scopeId/);

    clientScope.scopeId = "cli_1";
    const provided = validateMaintenanceForm(clientScope);
    expect(provided.ok).toBe(true);
    if (provided.ok) expect(provided.input.scopeId).toBe("cli_1");

    // The dependent picker resets the target on scope switches, so a stray
    // scopeId under global is CLEARED by the form (the shared schema still
    // rejects it server-side — covered by the api-maintenance tests).
    const globalScope = globalWindow();
    globalScope.scopeId = "cli_1";
    const cleared = validateMaintenanceForm(globalScope);
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.input.scopeId).toBeNull();
  });

  it("requires a title (shared schema rule)", () => {
    const values = globalWindow();
    values.title = "";
    const validation = validateMaintenanceForm(values);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.title).toMatch(/title is required/);
  });
});

describe("windowToFormValues (edit prefill)", () => {
  const window: MaintenanceWindowDto = {
    id: "mw_1",
    title: "Deploy",
    description: "Routine",
    scopeType: "client",
    scopeId: "cli_1",
    startsAt: "2026-09-05T12:00:00.000Z",
    endsAt: "2026-09-05T15:00:00.000Z",
    createdBy: null,
    createdAt: "2026-09-05T09:00:00.000Z",
    updatedAt: "2026-09-05T09:00:00.000Z",
    cancelledAt: null,
  };

  it("converts persisted UTC back to display-zone wall time (12:00Z → 11:00)", () => {
    const values = windowToFormValues(window, (iso) => utcToWallInput(iso));
    expect(values.startsAtWall).toBe("2026-09-05T11:00");
    expect(values.endsAtWall).toBe("2026-09-05T14:00");
    expect(values.scopeType).toBe("client");
    expect(values.scopeId).toBe("cli_1");
    expect(values.description).toBe("Routine");
  });

  it("round-trips an edit back to the identical UTC window", () => {
    const values = windowToFormValues(window, (iso) => utcToWallInput(iso));
    const validation = validateMaintenanceForm(values);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.input.startsAt).toBe(window.startsAt);
      expect(validation.input.endsAt).toBe(window.endsAt);
      expect(validation.input.scopeId).toBe("cli_1");
    }
  });
});
