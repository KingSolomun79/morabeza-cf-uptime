/**
 * State evaluation orchestration (issue #12; PRD §12, §16.4 step 5, §16.5).
 *
 * Runs INSIDE the monitor.check handler after the claimer's idempotent insert
 * (#9 seam): only the delivery that persisted the result may evaluate state.
 *
 * Gates honored here (the machine itself stays pure):
 * - `affects_state = 0` results (manual diagnostics, PRD §13) never evaluate;
 * - `maintenance_excluded = 1` results never evaluate (PRD §14; flagging of
 *   live windows lands in #15 — the machine just honors the flag);
 * - paused monitors never transition (the pure core no-ops on `paused`).
 *
 * Ordering (PRD §16.5): a scheduled result may only move state when its
 * `scheduledFor` is strictly newer than the row's
 * `last_evaluated_scheduled_for`; anything else is history-only. Combined
 * with the compare-and-set loop below this gives newest-wins under
 * interleaved deliveries: a CAS loser re-reads, re-checks ordering, and
 * re-evaluates against the winner's state or drops.
 */
import { logEvent } from "../lib/logging";
import { nowIso } from "../lib/time";
import {
  casUpdateMonitorState,
  ensureMonitorStateRow,
  toMachineState,
  type MonitorStatePatch,
} from "../repositories/monitor-state";
import {
  evaluateStateTransition,
  type MachineTransition,
  type MonitorStatus,
} from "./state-machine";
import type { AppDatabase } from "../lib/db";

export const MAX_CAS_ATTEMPTS = 3;

/** The persisted result slice evaluation needs (from check_results + monitor row). */
export interface CheckResultForEvaluation {
  checkId: string;
  source: "scheduled" | "manual";
  scheduledFor: string | null;
  isHealthy: boolean;
  maintenanceExcluded: boolean;
  affectsState: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  reasonCode: string;
  completedAt: string;
}

export interface MonitorThresholds {
  monitorId: string;
  failureThreshold: number;
  recoveryThreshold: number;
}

/**
 * Transition-event seam: #13 (incidents) and #17 (notifications) subscribe
 * here — DOWN opens an incident + enqueues DOWN email intents, RECOVERED
 * resolves + enqueues RECOVERED, `up` (unknown→up) intentionally emits NO
 * RECOVERED intent (PRD §12.5). Until those slices land the default listener
 * only logs, so the event exists in structured logs for operators.
 *
 * CONTRACT for subscribers: the event fires exactly once per check result,
 * AFTER the state CAS has committed — a redelivered message duplicate-skips
 * (#9) and can never re-emit it. Listeners must therefore persist their own
 * side effects idempotently keyed by `checkId` and never throw past this
 * seam: a throw would retry the message into the duplicate-skip, losing the
 * event permanently (state has already moved). This module isolates listener
 * failures as logged errors for exactly that reason.
 */
export interface StateTransitionEvent {
  monitorId: string;
  checkId: string;
  transition: MachineTransition;
  triggerScheduledFor: string;
  at: string;
  stateVersion: number;
  /** Why the triggering check failed/succeeded — incident open_reason_code (#13). */
  reasonCode: string;
}

export type TransitionListener = (event: StateTransitionEvent) => void | Promise<void>;

export function logTransitionEvent(event: StateTransitionEvent): void {
  logEvent("state.transition", {
    monitorId: event.monitorId,
    checkId: event.checkId,
    type: event.transition.type,
    from: event.transition.fromStatus,
    to: event.transition.toStatus,
    scheduledFor: event.triggerScheduledFor,
    failureSequenceStartedAt: event.transition.failureSequenceStartedAt,
    reasonCode: event.reasonCode,
    stateVersion: event.stateVersion,
  });
}

export type EvaluationOutcome =
  | { applied: true; transition: MachineTransition | null; status: MonitorStatus; stateVersion: number }
  | { applied: false; reason: "not_state_affecting" | "maintenance_excluded" | "missing_slot" | "stale" | "paused" | "cas_exhausted" };

export interface EvaluateStateDeps {
  db: AppDatabase;
  /** Defaults to structured-log emission; #13/#17 register real subscribers. */
  onTransition?: TransitionListener;
}

export async function evaluateCheckAgainstState(
  deps: EvaluateStateDeps,
  monitor: MonitorThresholds,
  result: CheckResultForEvaluation,
): Promise<EvaluationOutcome> {
  if (result.maintenanceExcluded) {
    return { applied: false, reason: "maintenance_excluded" };
  }
  if (!result.affectsState) {
    return { applied: false, reason: "not_state_affecting" };
  }
  if (result.scheduledFor === null) {
    // State-affecting results are always scheduled checks with a slot (PRD §15.4).
    return { applied: false, reason: "missing_slot" };
  }

  const db = deps.db;
  const onTransition = deps.onTransition ?? logTransitionEvent;

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const state = await ensureMonitorStateRow(db, monitor.monitorId, nowIso());

    // Out-of-order guard (PRD §16.5): only strictly newer slots may move state.
    if (state.lastEvaluatedScheduledFor !== null && result.scheduledFor <= state.lastEvaluatedScheduledFor) {
      return { applied: false, reason: "stale" };
    }

    const outcome = evaluateStateTransition(toMachineState(state), {
      isHealthy: result.isHealthy,
      failureThreshold: monitor.failureThreshold,
      recoveryThreshold: monitor.recoveryThreshold,
      completedAt: result.completedAt,
    });

    if (outcome.kind === "noop") {
      return { applied: false, reason: outcome.reason };
    }

    const patch: MonitorStatePatch = {
      status: outcome.next.status,
      consecutiveFailures: outcome.next.consecutiveFailures,
      consecutiveSuccesses: outcome.next.consecutiveSuccesses,
      failureSequenceStartedAt: outcome.next.failureSequenceStartedAt,
      lastEvaluatedScheduledFor: result.scheduledFor,
      lastCheckedAt: result.completedAt,
      lastSuccessAt: result.isHealthy ? result.completedAt : undefined,
      lastFailureAt: result.isHealthy ? undefined : result.completedAt,
      lastStatusCode: result.statusCode,
      lastResponseTimeMs: result.responseTimeMs,
      lastReasonCode: result.reasonCode,
      updatedAt: nowIso(),
    };

    const applied = await casUpdateMonitorState(db, monitor.monitorId, state.stateVersion, patch);
    if (applied) {
      const stateVersion = state.stateVersion + 1;
      if (outcome.transition) {
        // Diagnostics-only applies emit nothing; threshold crossings emit the
        // intent #13/#17 subscribe to (never for unknown→up "recovered-less").
        // Listener failures are isolated: state has already committed and a
        // propagated throw would retry into #9's duplicate-skip, losing the
        // event for good (see the TransitionListener contract above).
        try {
          await onTransition({
            monitorId: monitor.monitorId,
            checkId: result.checkId,
            transition: outcome.transition,
            triggerScheduledFor: result.scheduledFor,
            at: result.completedAt,
            stateVersion,
            reasonCode: result.reasonCode,
          });
        } catch (error) {
          logEvent("state.transition_listener_failed", {
            monitorId: monitor.monitorId,
            checkId: result.checkId,
            type: outcome.transition.type,
            outcome: "listener_isolated",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        applied: true,
        transition: outcome.transition,
        status: outcome.next.status,
        stateVersion,
      };
    }
    // CAS lost: another delivery applied a newer/interleaved result — re-read
    // and re-decide against ITS state (newest-wins, never blind overwrite).
  }

  logEvent("state.evaluation_dropped", {
    monitorId: monitor.monitorId,
    checkId: result.checkId,
    scheduledFor: result.scheduledFor,
    outcome: "cas_exhausted",
  });
  return { applied: false, reason: "cas_exhausted" };
}
