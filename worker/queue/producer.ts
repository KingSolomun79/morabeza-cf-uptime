/**
 * Queue producer (issue #8; PRD §16). Validates payloads BEFORE enqueueing so
 * malformed work never enters the queue. Job ids are supplied by the caller:
 * deterministic ids for scheduled/housekeeping work are what make duplicate
 * delivery harmless (PRD §15.4, §18).
 */
import { PAYLOAD_SCHEMAS, type Envelope, type MessageType, type PayloadOf } from "./schemas";

export interface EnvelopeInput<T extends MessageType> {
  type: T;
  jobId: string;
  payload: PayloadOf<T>;
}

export interface QueueLike {
  send(body: unknown): Promise<void>;
  sendBatch(bodies: unknown[]): Promise<void>;
}

export class QueueProducer {
  #queue: QueueLike;

  constructor(queue: QueueLike) {
    this.#queue = queue;
  }

  async send<T extends MessageType>(input: EnvelopeInput<T>): Promise<void> {
    this.#assertPayload(input.type, input.payload);
    await this.#queue.send(this.#envelope(input.type, input.jobId, input.payload));
  }

  async sendBatch(inputs: Array<EnvelopeInput<MessageType>>): Promise<void> {
    for (const input of inputs) {
      this.#assertPayload(input.type, input.payload);
    }
    await this.#queue.sendBatch(inputs.map((input) => this.#envelope(input.type, input.jobId, input.payload)));
  }

  #envelope(type: MessageType, jobId: string, payload: unknown): Envelope {
    return { v: 1, type, jobId, payload };
  }

  #assertPayload(type: MessageType, payload: unknown): void {
    const result = PAYLOAD_SCHEMAS[type].safeParse(payload);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(`refusing to enqueue ${type}: invalid payload — ${detail}`);
    }
  }
}

/** Adapts the production Queue binding to the producer's QueueLike port. */
export function queueBindingToQueueLike(binding: Queue): QueueLike {
  return {
    send: async (body) => {
      await binding.send(body);
    },
    sendBatch: async (bodies) => {
      await binding.sendBatch(bodies.map((body) => ({ body })));
    },
  };
}
