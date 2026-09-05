/**
 * State machine pure core (issue #12; PRD §12, §16.5).
 *
 * Deterministic and side-effect free: `(currentState, thresholds, result) →
 * nextState | no-op`. Persistence (compare-and-set ordering, out-of-order
 * guards) lives in worker/repositories/monitor-state.ts and
 * worker/services/state-evaluation.ts — this module never touches D1.
 *
 * Semantics (PRD §12):
 * - statuses: unknown | up | down | paused (maintenance is an overlay, §12.1);
 * - first healthy scheduled check: unknown → up immediately, NO RECOVERED
 *   intent (§12.5) — the transition type is `up`, distinct from `recovered`;
 * - DOWN on the threshold-crossing failure (§12.3); failures before the
 *   threshold never change status, they only count;
 * - RECOVERED on the threshold-crossing success (§12.4);
 * - a healthy evaluation resets consecutive failures to 0 and vice versa
 *   (§12.6); failure_sequence_started_at marks the FIRST failure of the
 *   qualifying sequence (incident start time, §12.3);
 * - paused monitors never transition via checks — paused is an operator
 *   action (PRD §23), the machine just honors it.
 */
export type MonitorStatus = "unknown" | "up" | "down" | "paused";

/** The slice of monitor_state the machine reads and writes (PRD §17.3). */
export interface MachineState {
  status: MonitorStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  failureSequenceStartedAt: string | null;
}

export interface MachineInput {
  isHealthy: boolean;
  failureThreshold: number;
  recoveryThreshold: number;
  /** Wall-clock completion time of the check — timestamps diagnostics and the failure sequence start. */
  completedAt: string;
}

/**
 * Transition intents emitted on threshold crossings. #13 (incidents) and #17
 * (notifications) subscribe to these via state-evaluation's listener seam.
 * `up` (from unknown) is deliberately NOT `recovered` — PRD §12.5 forbids a
 * RECOVERED email for unknown → up.
 */
export type TransitionType = "down" | "recovered" | "up";

export interface MachineTransition {
  type: TransitionType;
  fromStatus: MonitorStatus;
  toStatus: "up" | "down";
  /** Start of the qualifying failure sequence — set for `down`, null otherwise (PRD §12.3). */
  failureSequenceStartedAt: string | null;
}

export type MachineOutcome =
  | { kind: "noop"; reason: "paused" }
  | { kind: "apply"; next: MachineState; transition: MachineTransition | null };

export function evaluateStateTransition(current: MachineState, input: MachineInput): MachineOutcome {
  if (current.status === "paused") {
    return { kind: "noop", reason: "paused" };
  }

  if (input.isHealthy) {
    const next: MachineState = {
      status: current.status,
      consecutiveFailures: 0,
      consecutiveSuccesses: current.consecutiveSuccesses + 1,
      failureSequenceStartedAt: null, // a success always breaks the failure sequence (§12.6)
    };

    // unknown → up on the FIRST healthy scheduled check; no RECOVERED intent (§12.5).
    if (current.status === "unknown") {
      next.status = "up";
      return {
        kind: "apply",
        next,
        transition: { type: "up", fromStatus: "unknown", toStatus: "up", failureSequenceStartedAt: null },
      };
    }

    // DOWN → UP only on the threshold-crossing success (§12.4).
    if (current.status === "down" && next.consecutiveSuccesses >= input.recoveryThreshold) {
      next.status = "up";
      return {
        kind: "apply",
        next,
        transition: { type: "recovered", fromStatus: "down", toStatus: "up", failureSequenceStartedAt: null },
      };
    }

    // Still down (below recovery threshold) or already up: diagnostics-only apply.
    return { kind: "apply", next, transition: null };
  }

  const nextFailures = current.consecutiveFailures + 1;
  const sequenceStart = current.failureSequenceStartedAt ?? input.completedAt;
  const next: MachineState = {
    status: current.status,
    consecutiveFailures: nextFailures,
    consecutiveSuccesses: 0,
    failureSequenceStartedAt: sequenceStart,
  };

  // Threshold-crossing failure declares DOWN exactly once (§12.3); continued
  // failure keeps status down with no second transition.
  if (current.status !== "down" && nextFailures >= input.failureThreshold) {
    next.status = "down";
    return {
      kind: "apply",
      next,
      transition: { type: "down", fromStatus: current.status, toStatus: "down", failureSequenceStartedAt: sequenceStart },
    };
  }

  // Below threshold (unknown or up) or already down: counters only.
  return { kind: "apply", next, transition: null };
}
