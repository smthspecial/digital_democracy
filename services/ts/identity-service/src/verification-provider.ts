import type { VerificationMethod } from "./repositories/verification.js";

export interface VerificationOutcome {
  approved: boolean;
}

export type VerifyEvidence = (method: VerificationMethod, evidenceRef: string) => Promise<VerificationOutcome>;

// Placeholder for the real integration with national ID / passport /
// government credential verification systems (ADR-003). Approves any
// well-formed submission until that integration exists -- swap this for a
// real provider call without touching route logic.
export const stubVerifyEvidence: VerifyEvidence = async (_method, evidenceRef) => {
  return { approved: evidenceRef.trim().length > 0 };
};
