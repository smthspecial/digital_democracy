// @dd/event-bus is a thin wrapper around NATS JetStream (ADR-023, which
// supersedes ADR-016's Kafka/Redpanda choice -- see
// .spec/technical/adr/adr-023.md) giving TS services the same
// publish/durable-consume shape every ARCH-005 named queue needs: a
// producer that gets a persistence ack, and a consumer that processes
// messages one at a time, in order, acking only after successful handling
// so a crash mid-process redelivers rather than drops (at-least-once).
// Mirrors packages/go/eventbus's API shape for the Go side of the same
// convention.
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerConfig as NatsConsumerConfig,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
  type StreamConfig as NatsStreamConfig,
} from "@nats-io/jetstream";

export interface EventBus {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
  close(): Promise<void>;
}

/** Dials the NATS server at url (e.g. "nats://localhost:4222"). */
export async function connectEventBus(url: string): Promise<EventBus> {
  const nc = await connect({ servers: url, name: "digital-democracy" });
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  return {
    nc,
    js,
    jsm,
    async close() {
      await nc.drain();
    },
  };
}

export interface StreamConfig {
  /** JetStream stream name (upper-snake by convention, e.g. "AUDIT"). */
  name: string;
  /** Subjects this stream captures, e.g. ["audit.append"]. */
  subjects: string[];
}

/**
 * Idempotently provisions the stream so either a publisher or a consumer
 * can call it at startup without ordering assumptions about which service
 * boots first.
 */
export async function ensureStream(bus: EventBus, cfg: StreamConfig): Promise<void> {
  const streamCfg: Partial<NatsStreamConfig> & { name: string } = {
    name: cfg.name,
    subjects: cfg.subjects,
    // Audit-grade queues (ADR-016: "infinite retention... never deleted")
    // get this via Limits retention with no max_age/max_msgs set here;
    // callers needing bounded retention would extend StreamConfig -- not
    // needed by any queue this codebase has wired up yet.
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
  };
  try {
    await bus.jsm.streams.info(cfg.name);
    await bus.jsm.streams.update(cfg.name, streamCfg);
  } catch {
    await bus.jsm.streams.add(streamCfg);
  }
}

/**
 * Publishes payload as JSON to subject, waiting for JetStream's persistence
 * ack before returning -- the "did this actually get durably queued"
 * guarantee a plain nc.publish can't give.
 */
export async function publish(bus: EventBus, subject: string, payload: unknown): Promise<void> {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  await bus.js.publish(subject, data);
}

export interface ConsumerConfig {
  /** The StreamConfig.name this consumer binds to. */
  stream: string;
  /**
   * Durable consumer name -- reconnecting with the same name resumes from
   * where it left off rather than replaying or skipping (ARCH-005:
   * "exactly one consumer" per queue like audit.append maps to exactly one
   * durable name).
   */
  durable: string;
  /** Narrows delivery to one subject within the stream, if it captures more than one. */
  filterSubject?: string;
}

/**
 * Handler processes one message. Returning (or resolving) normally acks it;
 * throwing naks it (NATS will redeliver later) -- this is what makes the
 * queue at-least-once rather than at-most-once.
 */
export type Handler = (data: Uint8Array) => void | Promise<void>;

/**
 * Idempotently provisions the durable consumer described by cfg, then
 * processes messages one at a time (max_ack_pending 1), in delivery order,
 * until stop() is called. A handler error naks the message (redelivered,
 * per DP-036's ordering requirement this must not just skip ahead) rather
 * than being silently dropped or crashing the process.
 */
export async function consume(
  bus: EventBus,
  cfg: ConsumerConfig,
  handle: Handler,
): Promise<{ stop: () => Promise<void> }> {
  const consumerCfg: Partial<NatsConsumerConfig> = {
    durable_name: cfg.durable,
    ack_policy: AckPolicy.Explicit,
    max_ack_pending: 1,
  };
  if (cfg.filterSubject) {
    consumerCfg.filter_subject = cfg.filterSubject;
  }
  try {
    await bus.jsm.consumers.info(cfg.stream, cfg.durable);
  } catch {
    await bus.jsm.consumers.add(cfg.stream, consumerCfg);
  }

  const consumer = await bus.js.consumers.get(cfg.stream, cfg.durable);
  const messages = await consumer.consume({
    callback: (msg: JsMsg) => {
      void (async () => {
        try {
          await handle(msg.data);
          msg.ack();
        } catch {
          msg.nak();
        }
      })();
    },
  });

  return {
    async stop() {
      await messages.close();
    },
  };
}
