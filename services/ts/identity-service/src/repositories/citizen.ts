import { randomUUID } from "node:crypto";
import type pg from "pg";
import { DuplicateIdentityError } from "./errors.js";

export type CitizenshipStatus = "citizen" | "revoked" | "suspended";
export type CitizenAccountStatus = "pending" | "active" | "inactive" | "revoked";

export interface Citizen {
  id: string;
  publicHandle: string;
  citizenshipStatus: CitizenshipStatus;
  legalIdentityHash: string;
  status: CitizenAccountStatus;
  createdAt: Date;
}

export interface CitizenRepository {
  create(input: { publicHandle: string; legalIdentityHash: string }): Promise<Citizen>;
  findById(id: string): Promise<Citizen | undefined>;
  updateStatus(id: string, status: CitizenAccountStatus): Promise<Citizen>;
  // DP-024: other pending/active citizens sharing the same legal identity.
  findLiveByLegalHash(legalIdentityHash: string, excludeId: string): Promise<Citizen[]>;
}

const UNIQUE_VIOLATION = "23505";

export class PgCitizenRepository implements CitizenRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: { publicHandle: string; legalIdentityHash: string }): Promise<Citizen> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO citizen (public_handle, legal_identity_hash)
         VALUES ($1, $2)
         RETURNING *`,
        [input.publicHandle, input.legalIdentityHash],
      );
      return toCitizen(rows[0]);
    } catch (err) {
      if (isPgError(err) && err.code === UNIQUE_VIOLATION) {
        throw new DuplicateIdentityError();
      }
      throw err;
    }
  }

  async findById(id: string): Promise<Citizen | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM citizen WHERE id = $1", [id]);
    return rows[0] ? toCitizen(rows[0]) : undefined;
  }

  async updateStatus(id: string, status: CitizenAccountStatus): Promise<Citizen> {
    const { rows } = await this.pool.query(
      "UPDATE citizen SET status = $2 WHERE id = $1 RETURNING *",
      [id, status],
    );
    if (!rows[0]) throw new Error(`citizen ${id} not found`);
    return toCitizen(rows[0]);
  }

  async findLiveByLegalHash(legalIdentityHash: string, excludeId: string): Promise<Citizen[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM citizen
       WHERE legal_identity_hash = $1 AND id != $2 AND status IN ('pending', 'active')`,
      [legalIdentityHash, excludeId],
    );
    return rows.map(toCitizen);
  }
}

export class InMemoryCitizenRepository implements CitizenRepository {
  private readonly rows = new Map<string, Citizen>();

  async create(input: { publicHandle: string; legalIdentityHash: string }): Promise<Citizen> {
    const conflict = [...this.rows.values()].some(
      (c) => c.legalIdentityHash === input.legalIdentityHash && (c.status === "pending" || c.status === "active"),
    );
    if (conflict) throw new DuplicateIdentityError();

    const citizen: Citizen = {
      id: randomUUID(),
      publicHandle: input.publicHandle,
      citizenshipStatus: "citizen",
      legalIdentityHash: input.legalIdentityHash,
      status: "pending",
      createdAt: new Date(),
    };
    this.rows.set(citizen.id, citizen);
    return citizen;
  }

  async findById(id: string): Promise<Citizen | undefined> {
    return this.rows.get(id);
  }

  async updateStatus(id: string, status: CitizenAccountStatus): Promise<Citizen> {
    const citizen = this.rows.get(id);
    if (!citizen) throw new Error(`citizen ${id} not found`);
    const updated = { ...citizen, status };
    this.rows.set(id, updated);
    return updated;
  }

  async findLiveByLegalHash(legalIdentityHash: string, excludeId: string): Promise<Citizen[]> {
    return [...this.rows.values()].filter(
      (c) => c.legalIdentityHash === legalIdentityHash && c.id !== excludeId && (c.status === "pending" || c.status === "active"),
    );
  }
}

function isPgError(err: unknown): err is { code: string } {
  return typeof err === "object" && err !== null && "code" in err;
}

function toCitizen(row: {
  id: string;
  public_handle: string;
  citizenship_status: CitizenshipStatus;
  legal_identity_hash: string;
  status: CitizenAccountStatus;
  created_at: Date;
}): Citizen {
  return {
    id: row.id,
    publicHandle: row.public_handle,
    citizenshipStatus: row.citizenship_status,
    legalIdentityHash: row.legal_identity_hash,
    status: row.status,
    createdAt: row.created_at,
  };
}
