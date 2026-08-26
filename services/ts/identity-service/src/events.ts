export interface DomainEvent {
  topic: string;
  payload: Record<string, unknown>;
}

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

interface Logger {
  info(obj: unknown, msg?: string): void;
}

// Stands in for the Kafka producer described in ARCH-006 (per-region
// Strimzi cluster) until one is wired up. Routes only depend on the
// EventPublisher interface, so swapping this for a real producer later
// does not touch call sites.
export class LoggingEventPublisher implements EventPublisher {
  constructor(private readonly logger: Logger) {}

  async publish(event: DomainEvent): Promise<void> {
    this.logger.info({ event }, `publish -> ${event.topic}`);
  }
}
