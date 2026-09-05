/**
 * Queue message contracts (issue #8; PRD §16).
 *
 * Every message is an envelope `{ v, type, jobId, payload }`:
 * - `v` schema version (PRD §16.2),
 * - `jobId` the caller's idempotency key — DETERMINISTIC for scheduled and
 *   housekeeping work so duplicate enqueue/delivery cannot double-execute
 *   (PRD §15.4, §18),
 * - `payload` validated per type below, at both enqueue and consume time.
 *
 * Cloudflare Queues is at-least-once: handlers MUST be idempotent and use the
 * unique-key insert pattern from worker/queue/idempotency (PRD §16.3).
 */
import { z } from "zod";

export const QUEUE_NAMES = {
  checks: "morabeza-cf-uptime-checks",
  dlq: "morabeza-cf-uptime-checks-dlq",
} as const;

export const MESSAGE_TYPES = [
  "monitor.check",
  "notification.send",
  "system.heartbeat",
  "rollup.hourly",
  "rollup.daily",
  "retention.cleanup",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export const envelopeSchema = z.object({
  v: z.literal(1),
  type: z.enum(MESSAGE_TYPES),
  jobId: z.string().min(1),
  payload: z.unknown(),
});

export type Envelope = z.output<typeof envelopeSchema>;

/** Payload schemas per message type. Later slices refine handler behavior,
 * not the wire contract: #9 executes checks, #17 sends email, #18/#19
 * housekeeping. */
export const PAYLOAD_SCHEMAS = {
  "monitor.check": z.object({
    monitorId: z.string().min(1),
    checkId: z.string().min(1),
    scheduledFor: z.string().min(1).nullable(),
    source: z.enum(["scheduled", "manual"]),
    affectsState: z.boolean(),
  }),
  "notification.send": z.object({
    notificationEventId: z.string().min(1),
  }),
  "system.heartbeat": z.object({}).passthrough(),
  "rollup.hourly": z.object({
    hourStart: z.string().min(1),
  }),
  "rollup.daily": z.object({
    dayStart: z.string().min(1),
  }),
  "retention.cleanup": z.object({}).passthrough(),
} as const satisfies Record<MessageType, z.ZodType>;

export type PayloadOf<T extends MessageType> = z.output<(typeof PAYLOAD_SCHEMAS)[T]>;

export function parseEnvelope(body: unknown): Envelope {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new QueueMessageError("invalid envelope", parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })));
  }
  const payloadSchema = PAYLOAD_SCHEMAS[parsed.data.type];
  const payload = payloadSchema.safeParse(parsed.data.payload);
  if (!payload.success) {
    throw new QueueMessageError(`invalid payload for ${parsed.data.type}`, payload.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })));
  }
  return { ...parsed.data, payload: payload.data };
}

export class QueueMessageError extends Error {
  readonly issues: Array<{ path: string; message: string }>;

  constructor(message: string, issues: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "QueueMessageError";
    this.issues = issues;
  }
}
