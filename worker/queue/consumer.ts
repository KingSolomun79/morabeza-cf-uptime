/**
 * Main queue consumer router (issue #8; PRD §16, §37).
 *
 * Batch semantics (PRD §37.9): one failing message NEVER fails the batch —
 * each message is acked on success or marked for retry individually; after
 * max_retries (3, wrangler config) exhausted messages move to the DLQ.
 *
 * Heartbeat: `last_queue_consumer_at` is refreshed once per batch of real
 * work and powers /healthz degradation checks (#11, PRD §19).
 *
 * Handlers yet to land (#9 check execution, #17 email, #18/#19 housekeeping)
 * are registered as explicit not-implemented stubs: they fail loudly and land
 * in the DLQ rather than being silently dropped.
 */
import { logEvent } from "../lib/logging";
import { touchQueueConsumerHeartbeat } from "../repositories/system";
import { parseEnvelope, type Envelope, type MessageType, type PayloadOf } from "./schemas";
import type { Env } from "../env";

export interface JobContext {
  env: Env;
  jobId: string;
  messageId: string;
}

export type JobHandler<T extends MessageType> = (
  payload: PayloadOf<T>,
  ctx: JobContext,
) => Promise<void>;

export type JobHandlerMap = {
  [K in MessageType]: JobHandler<K>;
};

export interface MessageLike {
  id: string;
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface BatchLike {
  queue: string;
  messages: MessageLike[];
}

const RETRY_DELAY_SECONDS = 5;

function notImplemented(type: MessageType): JobHandler<MessageType> {
  return async () => {
    throw new Error(`queue handler for ${type} is not implemented yet`);
  };
}

/**
 * The full V1 handler registry. Implemented handlers grow slice by slice:
 * #9 (monitor.check), #17 (notification.send), #18 (rollups), #19 (retention).
 */
export function defaultRegistry(): JobHandlerMap {
  return {
    "monitor.check": notImplemented("monitor.check"),
    "notification.send": notImplemented("notification.send"),
    "system.heartbeat": async () => {
      // Processing this job IS the heartbeat (batch-level update below);
      // the body stays intentionally empty (PRD §18: every-5-minutes
      // synthetic queue heartbeat keeps last_queue_consumer_at fresh).
    },
    "rollup.hourly": notImplemented("rollup.hourly"),
    "rollup.daily": notImplemented("rollup.daily"),
    "retention.cleanup": notImplemented("retention.cleanup"),
  };
}

export function createQueueConsumer(registry: JobHandlerMap = defaultRegistry()) {
  return async function handleQueueBatch(batch: BatchLike, env: Env): Promise<void> {
    await touchQueueConsumerHeartbeat(env);

    for (const message of batch.messages) {
      let parsed: Envelope | null = null;
      try {
        parsed = parseEnvelope(message.body);
        // Union-of-handlers call signatures need this widening; the payload
        // has already been validated against the per-type schema.
        const handler = registry[parsed.type] as (payload: unknown, ctx: JobContext) => Promise<void>;
        await handler(parsed.payload, {
          env,
          jobId: parsed.jobId,
          messageId: message.id,
        });
        message.ack();
        logEvent("queue.job_completed", {
          jobId: parsed.jobId,
          type: parsed.type,
          outcome: "ok",
        });
      } catch (error) {
        const err = error as Error;
        message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
        logEvent("queue.job_failed", {
          jobId: parsed?.jobId ?? null,
          type: parsed?.type ?? null,
          messageId: message.id,
          outcome: "retry_scheduled",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
}
