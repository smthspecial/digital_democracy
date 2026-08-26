import { randomUUID } from "node:crypto";
import type pg from "pg";

export type VerificationMethod = "national_id" | "passport" | "gov_credential";
export type VerificationStatus = "pending" | "verified" | "rejected";

export interface IdentityVerification {
  id: string;
  citizenId: string;
  method: VerificationMethod;
  evidenceRef: string;
  verifiedAt: Date | undefined;
  status: VerificationStatus;
  createdAt: Date;
}

export interface VerificationRepository {
  create(input: {
    citizenId: string;
    method: VerificationMethod;
    evidenceRef: string;
    status: VerificationStatus;
    verifiedAt: Date | undefined;
  }): Promise<IdentityVerification>;
}

export class PgVerificationRepository implements VerificationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: {
    citizenId: string;
    method: VerificationMethod;
    evidenceRef: string;
    status: VerificationStatus;
    verifiedAt: Date | undefined;
  }): Promise<IdentityVerification> {
    const { rows } = await this.pool.query(
      `INSERT INTO identity_verification (citizen_id, method, evidence_ref, status, verified_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.citizenId, input.method, input.evidenceRef, input.status, input.verifiedAt ?? null],
    );
    return toVerification(rows[0]);
  }
}

export class InMemoryVerificationRepository implements VerificationRepository {
  private readonly rows = new Map<string, IdentityVerification>();

  async create(input: {
    citizenId: string;
    method: VerificationMethod;
    evidenceRef: string;
    status: VerificationStatus;
    verifiedAt: Date | undefined;
  }): Promise<IdentityVerification> {
    const verification: IdentityVerification = { id: randomUUID(), createdAt: new Date(), ...input };
    this.rows.set(verification.id, verification);
    return verification;
  }
}

function toVerification(row: {
  id: string;
  citizen_id: string;
  method: VerificationMethod;
  evidence_ref: string;
  verified_at: Date | null;
  status: VerificationStatus;
  created_at: Date;
}): IdentityVerification {
  return {
    id: row.id,
    citizenId: row.citizen_id,
    method: row.method,
    evidenceRef: row.evidence_ref,
    verifiedAt: row.verified_at ?? undefined,
    status: row.status,
    createdAt: row.created_at,
  };
}
