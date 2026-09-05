import type { Env } from "./env";
import app from "./app";
import { QUEUE_NAMES } from "./queue/schemas";
import { createQueueConsumer, type BatchLike } from "./queue/consumer";
import { handleDeadLetterBatch } from "./queue/dlq-consumer";

const handleQueueBatch = createQueueConsumer();

export default {
  fetch: app.fetch,
  /**
   * One Worker consumes both queues (PRD §16.1, §16.6): batches are routed by
   * queue name — the main queue runs the job router; the DLQ consumer records
   * dead_letter_events then acks.
   */
  queue: (batch: MessageBatch, env: Env): Promise<void> => {
    if (batch.queue === QUEUE_NAMES.dlq) {
      return handleDeadLetterBatch(batch as unknown as BatchLike, env);
    }
    return handleQueueBatch(batch as unknown as BatchLike, env);
  },
} satisfies ExportedHandler<Env>;
