export type CitizenshipStatus = "citizen" | "revoked" | "suspended";
export type CitizenStatus = "pending" | "active" | "inactive" | "revoked";

export interface Citizen {
  id: string;
  publicHandle: string;
  citizenshipStatus: CitizenshipStatus;
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
  verifiedAt: Date | null;
  status: VerificationOutcome;
}

export interface RegisterCitizenInput {
  publicHandle: string;
  legalIdentityHash: string;
}

export interface CreateVerificationInput {
  citizenId: string;
  method: VerificationMethod;
  evidenceRef: string;
  outcome: VerificationOutcome;
}
