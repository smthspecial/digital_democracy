import { buildServer } from "./server.js";
import type { DomainEvent, EventPublisher } from "./events.js";
import { InMemoryCitizenRepository } from "./repositories/citizen.js";
import { InMemoryVerificationRepository } from "./repositories/verification.js";
import type { VerifyEvidence } from "./verification-provider.js";

export class RecordingEventPublisher implements EventPublisher {
  readonly events: DomainEvent[] = [];

  async publish(event: DomainEvent): Promise<void> {
    this.events.push(event);
  }
}

export function buildTestServer(overrides?: { verifyEvidence?: VerifyEvidence }) {
  const events = new RecordingEventPublisher();
  const app = buildServer({
    citizenRepo: new InMemoryCitizenRepository(),
    verificationRepo: new InMemoryVerificationRepository(),
    events,
    verifyEvidence: overrides?.verifyEvidence ?? (async () => ({ approved: true })),
    identityHashSecret: "test-secret",
  });
  return { app, events };
}
