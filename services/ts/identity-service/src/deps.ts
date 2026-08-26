import type { EventPublisher } from "./events.js";
import type { CitizenRepository } from "./repositories/citizen.js";
import type { VerificationRepository } from "./repositories/verification.js";
import type { VerifyEvidence } from "./verification-provider.js";

export interface ServiceDeps {
  citizenRepo: CitizenRepository;
  verificationRepo: VerificationRepository;
  events: EventPublisher;
  verifyEvidence: VerifyEvidence;
  identityHashSecret: string;
}
