import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import {
  InternalServiceGuard,
  SignedRequestVerifier,
} from "../common/internal-service.guard.js";
import { JurisdictionModule } from "../jurisdiction/jurisdiction.module.js";
import { ProposalModule } from "../proposal/proposal.module.js";
import { JourneyController } from "./journey.controller.js";
import { JourneyService } from "./journey.service.js";
import { VotingRuntime } from "./voting-runtime.js";

@Module({
  imports: [ProposalModule, JurisdictionModule],
  controllers: [JourneyController],
  providers: [
    JourneyService,
    VotingRuntime,
    InternalServiceGuard,
    SignedRequestVerifier,
    { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter },
  ],
})
export class JourneyModule {}
