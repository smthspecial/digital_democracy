import { Injectable, Logger } from "@nestjs/common";

export const CONSTITUTIONAL_REVIEWER = Symbol("CONSTITUTIONAL_REVIEWER");

export interface ConstitutionalReviewer {
  isCleared(proposalId: string): Promise<boolean>;
}

export class NoopConstitutionalReviewer implements ConstitutionalReviewer {
  async isCleared(): Promise<boolean> {
    return false;
  }
}

// ADR-035 D20 / ADR-038 D11: fail-closed on anything short of a real
// cleared review. audit-service's POST /audit/reviews (DP-034) is a real,
// tested endpoint (apps/api-go/internal/audit) -- unlike the pre-ADR-027
// design this port's comment used to describe, SRV-012 does exist now,
// this app just never called it (ARCH-027 pattern #2).
//
// affected_right_ids is always sent empty: no code anywhere in this repo
// derives which constitutional rights a proposal's content touches (no
// keyword/NLP analysis exists -- TP-013 EC-47 documents this as a real,
// still-open gap, not something this class claims to solve). This wiring
// closes the "never called" gap -- a real service-to-service review now
// runs and is recorded -- not the "no content analysis" gap, which stays
// open until someone builds that derivation.
@Injectable()
export class HttpConstitutionalReviewer implements ConstitutionalReviewer {
  private readonly logger = new Logger(HttpConstitutionalReviewer.name);
  private readonly auditServiceUrl = process.env.AUDIT_SERVICE_URL;

  async isCleared(proposalId: string): Promise<boolean> {
    if (!this.auditServiceUrl) {
      return false;
    }
    try {
      const response = await fetch(`${this.auditServiceUrl}/audit/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proposal_id: proposalId,
          affected_right_ids: [],
          reviewer_ref: "proposal-service",
        }),
      });
      if (!response.ok) {
        this.logger.error(`constitutional review failed: HTTP ${response.status} for proposal ${proposalId}`);
        return false;
      }
      const body = (await response.json()) as { blocked: boolean };
      return !body.blocked;
    } catch (err) {
      this.logger.error(`constitutional review failed: ${(err as Error).message} for proposal ${proposalId}`);
      return false;
    }
  }
}
