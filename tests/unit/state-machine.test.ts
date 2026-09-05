/**
 * Issue #12 — state machine pure core, PRD §32.1 "State machine" matrix.
 * No D1: the pure function folds (state, thresholds, result) → next state.
 * Persistence/ordering/CAS behavior is covered in state-evaluation.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateStateTransition,
  type MachineInput,
  type MachineState,
  type MachineTransition,
} from "../../worker/services/state-machine";

const INITIAL: MachineState = {
  status: "unknown",
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  failureSequenceStartedAt: null,
};

function input(overrides: Partial<MachineInput> = {}): MachineInput {
  return {
    isHealthy: true,
    failureThreshold: 3,
    recoveryThreshold: 2,
    completedAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

/** Folds a sequence of results through the machine, collecting transitions. */
function fold(
  start: MachineState,
  results: Array<{ healthy: boolean; at: string }>,
  thresholds: { failureThreshold: number; recoveryThreshold: number } = { failureThreshold: 3, recoveryThreshold: 2 },
): { state: MachineState; transitions: MachineTransition[] } {
  let state = start;
  const transitions: MachineTransition[] = [];
  for (const r of results) {
    const outcome = evaluateStateTransition(state, {
      isHealthy: r.healthy,
      ...thresholds,
      completedAt: r.at,
    });
    if (outcome.kind === "apply") {
      state = outcome.next;
      if (outcome.transition) transitions.push(outcome.transition);
    }
  }
  return { state, transitions };
}

describe("state machine matrix (PRD §32.1)", () => {
  it("unknown → up on the first healthy scheduled check (PRD §12.5)", () => {
    const outcome = evaluateStateTransition(INITIAL, input({ completedAt: "2026-09-05T12:01:00.000Z" }));
    expect(outcome).toMatchObject({
      kind: "apply",
      next: { status: "up", consecutiveFailures: 0, consecutiveSuccesses: 1, failureSequenceStartedAt: null },
    });
    if (outcome.kind === "apply") {
      expect(outcome.transition).toMatchObject({ type: "up", fromStatus: "unknown", toStatus: "up" });
      // §12.5: unknown→up is NOT a recovery — no RECOVERED intent may exist.
      expect(outcome.transition?.type).not.toBe("recovered");
    }
  });

  it("unknown failures do not declare DOWN before the threshold", () => {
    const { state, transitions } = fold(INITIAL, [
      { healthy: false, at: "2026-09-05T12:01:00.000Z" },
      { healthy: false, at: "2026-09-05T12:02:00.000Z" },
    ]);
    expect(state.status).toBe("unknown");
    expect(state.consecutiveFailures).toBe(2);
    expect(state.consecutiveSuccesses).toBe(0);
    expect(transitions).toHaveLength(0);
  });

  it("third failure declares DOWN with default threshold, stamped with the FIRST failure of the sequence (PRD §12.3)", () => {
    const { state, transitions } = fold(INITIAL, [
      { healthy: false, at: "2026-09-05T12:01:00.000Z" },
      { healthy: false, at: "2026-09-05T12:02:00.000Z" },
      { healthy: false, at: "2026-09-05T12:03:00.000Z" },
    ]);
    expect(state.status).toBe("down");
    expect(state.consecutiveFailures).toBe(3);
    expect(state.failureSequenceStartedAt).toBe("2026-09-05T12:01:00.000Z");
    expect(transitions).toEqual([
      {
        type: "down",
        fromStatus: "unknown",
        toStatus: "down",
        failureSequenceStartedAt: "2026-09-05T12:01:00.000Z",
      },
    ]);
  });

  it("continued failure does not create a second DOWN transition", () => {
    const { state, transitions } = fold(INITIAL, [
      { healthy: false, at: "2026-09-05T12:01:00.000Z" },
      { healthy: false, at: "2026-09-05T12:02:00.000Z" },
      { healthy: false, at: "2026-09-05T12:03:00.000Z" },
      { healthy: false, at: "2026-09-05T12:04:00.000Z" },
      { healthy: false, at: "2026-09-05T12:05:00.000Z" },
    ]);
    expect(state.status).toBe("down");
    expect(transitions).toHaveLength(1); // exactly the threshold crossing
    expect(state.failureSequenceStartedAt).toBe("2026-09-05T12:01:00.000Z");
  });

  it("first success while DOWN does not recover with threshold 2 (PRD §12.4)", () => {
    const down: MachineState = {
      status: "down",
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
      failureSequenceStartedAt: "2026-09-05T12:01:00.000Z",
    };
    const outcome = evaluateStateTransition(down, input({ isHealthy: true, completedAt: "2026-09-05T12:04:00.000Z" }));
    expect(outcome).toMatchObject({
      kind: "apply",
      next: { status: "down", consecutiveFailures: 0, consecutiveSuccesses: 1 },
    });
    if (outcome.kind === "apply") expect(outcome.transition).toBeNull();
  });

  it("second success recovers and clears the failure sequence", () => {
    const downOneSuccess: MachineState = {
      status: "down",
      consecutiveFailures: 0,
      consecutiveSuccesses: 1,
      failureSequenceStartedAt: null,
    };
    const outcome = evaluateStateTransition(downOneSuccess, input({ isHealthy: true, completedAt: "2026-09-05T12:05:00.000Z" }));
    expect(outcome).toMatchObject({
      kind: "apply",
      next: { status: "up", consecutiveSuccesses: 2, failureSequenceStartedAt: null },
    });
    if (outcome.kind === "apply") {
      expect(outcome.transition).toMatchObject({ type: "recovered", fromStatus: "down", toStatus: "up" });
    }
  });

  it("counters reset correctly in both directions (PRD §12.6)", () => {
    // Success resets consecutive failures (and the sequence stamp).
    const flapping: MachineState = {
      status: "up",
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
      failureSequenceStartedAt: "2026-09-05T12:02:00.000Z",
    };
    const afterSuccess = evaluateStateTransition(flapping, input({ isHealthy: true }));
    expect(afterSuccess).toMatchObject({
      kind: "apply",
      next: { consecutiveFailures: 0, failureSequenceStartedAt: null, status: "up" },
    });

    // Failure resets consecutive successes.
    const upState: MachineState = { status: "up", consecutiveFailures: 0, consecutiveSuccesses: 7, failureSequenceStartedAt: null };
    const afterFailure = evaluateStateTransition(upState, input({ isHealthy: false }));
    expect(afterFailure).toMatchObject({
      kind: "apply",
      next: { consecutiveSuccesses: 0, consecutiveFailures: 1, failureSequenceStartedAt: "2026-09-05T12:00:00.000Z" },
    });
  });

  it("failures while UP below threshold keep status up but start the failure sequence", () => {
    const up: MachineState = { status: "up", consecutiveFailures: 0, consecutiveSuccesses: 4, failureSequenceStartedAt: null };
    const { state, transitions } = fold(up, [
      { healthy: false, at: "2026-09-05T12:01:00.000Z" },
      { healthy: false, at: "2026-09-05T12:02:00.000Z" },
    ]);
    expect(state.status).toBe("up");
    expect(state.consecutiveFailures).toBe(2);
    expect(transitions).toHaveLength(0);
  });

  it("a success after a below-threshold failure run breaks the sequence (fresh stamp on the next run)", () => {
    const { state } = fold(INITIAL, [
      { healthy: false, at: "2026-09-05T12:01:00.000Z" },
      { healthy: true, at: "2026-09-05T12:02:00.000Z" },
      { healthy: false, at: "2026-09-05T12:03:00.000Z" },
    ]);
    expect(state.failureSequenceStartedAt).toBe("2026-09-05T12:03:00.000Z");
    expect(state.consecutiveFailures).toBe(1);
  });

  it("paused monitors never transition via checks (healthy or failing)", () => {
    const paused: MachineState = { status: "paused", consecutiveFailures: 0, consecutiveSuccesses: 0, failureSequenceStartedAt: null };
    expect(evaluateStateTransition(paused, input({ isHealthy: true }))).toEqual({ kind: "noop", reason: "paused" });
    expect(evaluateStateTransition(paused, input({ isHealthy: false }))).toEqual({ kind: "noop", reason: "paused" });
  });

  it("unknown → up emits no RECOVERED intent across a full fold", () => {
    const { transitions } = fold(INITIAL, [{ healthy: true, at: "2026-09-05T12:01:00.000Z" }]);
    expect(transitions.map((t) => t.type)).toEqual(["up"]);
    expect(transitions.some((t) => t.type === "recovered")).toBe(false);
  });

  it("threshold 1 declares DOWN on the very first failure", () => {
    const { state, transitions } = fold(
      INITIAL,
      [{ healthy: false, at: "2026-09-05T12:01:00.000Z" }],
      { failureThreshold: 1, recoveryThreshold: 1 },
    );
    expect(state.status).toBe("down");
    expect(transitions).toEqual([
      { type: "down", fromStatus: "unknown", toStatus: "down", failureSequenceStartedAt: "2026-09-05T12:01:00.000Z" },
    ]);
  });

  it("recovery threshold 1 recovers on the first success", () => {
    const down: MachineState = {
      status: "down",
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
      failureSequenceStartedAt: "2026-09-05T12:01:00.000Z",
    };
    const outcome = evaluateStateTransition(down, input({ isHealthy: true, recoveryThreshold: 1 }));
    expect(outcome.kind).toBe("apply");
    if (outcome.kind === "apply") {
      expect(outcome.next.status).toBe("up");
      expect(outcome.transition?.type).toBe("recovered");
    }
  });
});
