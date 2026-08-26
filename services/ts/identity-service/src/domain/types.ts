export type CitizenStatus = "pending" | "active" | "suspended" | "revoked";

// TBL-001 also defines a `citizenship_status` enum (citizen|revoked|suspended)
// that overlaps with `status` (active|inactive|revoked); the two collapse
// into this single lifecycle field since DP-001/DP-002 and the suspend/revoke
// endpoints only ever need one status to reason about.
export interface Citizen {
  id: string;
  publicHandle: string;
  legalIdentityHash: string;
  status: CitizenStatus;
  createdAt: Date;
}

export type VerificationMethod = "national_id" | "passport" | "gov_credential";
export type VerificationOutcome = "verified" | "rejected";

export interface IdentityVerification {
  id: string;
  citizenId: string;
  method: VerificationMethod;
  evidenceRef: string;
  status: VerificationOutcome;
  verifiedAt: Date | null;
}
