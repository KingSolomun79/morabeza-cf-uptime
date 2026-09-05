/**
 * Dead-letter queue consumer (issue #8; PRD §16.6): the same Worker consumes
 * the DLQ, persists a dead_letter_events row for operator visibility
 * (System page, #26), then acknowledges the message.
 *
 * Deliberately side-effect-free beyond that D1 row: no notifications are
 * produced from DLQ processing, so a failing Email Service job cannot create
 * a recursive alert loop (PRD §16.6).
 */
import { getDb } from "../lib/db";
import { newId } from "../lib/ids";
import { logEvent } from "../lib/logging";
import { nowIso } from "../lib/time";
import { deadLetterEvents } from "../../db/schema";
import { envelopeSchema } from "./schemas";
import type { BatchLike } from "./consumer";
import type { Env } from "../env";

const SUMMARY_MAX_CHARS = 500;

function buildPayloadSummary(body: unknown): string {
  let serialized: string;
  try {
    serialized = typeof body === "string" ? body : JSON.stringify(body) ?? String(body);
  } catch {
    serialized = String(body);
  }
  return serialized.length > SUMMARY_MAX_CHARS
    ? serialized.slice(0, SUMMARY_MAX_CHARS)
    : serialized;
}

export async function handleDeadLetterBatch(batch: BatchLike, env: Env): Promise<void> {
  const db = getDb(env);

  for (const message of batch.messages) {
    const lenient = envelopeSchema.safeParse(message.body);

    await db.insert(deadLetterEvents).values({
      id: newId("dlq"),
      originalJobId: lenient.success ? lenient.data.jobId : null,
      messageType: lenient.success ? lenient.data.type : null,
      payloadSummaryJson: JSON.stringify({ summary: buildPayloadSummary(message.body) }),
      failureReason: "message exhausted its retries and was moved to the dead-letter queue",
      receivedAt: nowIso(),
    });

    message.ack();
    logEvent("queue.dead_letter_recorded", {
      messageId: message.id,
      jobId: lenient.success ? lenient.data.jobId : null,
      type: lenient.success ? lenient.data.type : null,
      outcome: "ok",
    });
  }
}
