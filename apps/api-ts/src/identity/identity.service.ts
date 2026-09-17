import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import {
  ConflictDomainError,
  ForbiddenDomainError,
  InvalidStateDomainError,
  NotFoundDomainError,
} from "../common/domain-errors.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { CitizenStatusChecker } from "./citizen-status.port.js";
import { hashLegalIdentifier } from "./legal-identity-hash.js";
import {
  Citizen,
  CreateVerificationInput,
  IdentityVerification,
  RegisterCitizenInput,
  VerificationMethod,
  VerificationOutcome,
} from "./identity.types.js";

const UNIQUE_VIOLATION = "P2002";

export interface RegisterInput {
  publicHandle: string;
  legalIdentifier: string;
}

export interface SubmitVerificationInput {
  method: VerificationMethod;
  evidenceRef: string;
  outcome: VerificationOutcome;
}

export interface SubmitVerificationResult {
  citizen: Citizen;
  verification: IdentityVerification;
}

// DP-001, DP-002 / SRV-001: talks to Postgres directly via PrismaService's
// dual api_app/api_worker connections (ADR-030) -- no repository
// indirection.
@Injectable()
export class IdentityService implements CitizenStatusChecker {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  // DP-001: creates a `citizen` record with status=pending. Does not
  // activate until identity verification succeeds (DP-002). FR-001's
  // duplicate-rejection AC is enforced below.
  async register(input: RegisterInput): Promise<Citizen> {
    const legalIdentityHash = hashLegalIdentifier(input.legalIdentifier);
    return this.registerCitizen({ publicHandle: input.publicHandle, legalIdentityHash });
  }

  // DP-002: records a verification attempt with its outcome supplied
  // synchronously in the same call. When verified and the citizen is
  // currently pending, activates the citizen (citizen:activate, AUTH-010
  // system-only permission) and emits DP-036.
  async submitVerification(citizenId: string, input: SubmitVerificationInput): Promise<SubmitVerificationResult> {
    const citizen = await this.findCitizenById(citizenId);
    if (!citizen) {
      throw new NotFoundDomainError("citizen", citizenId);
    }
    if (citizen.status !== "pending") {
      throw new InvalidStateDomainError(
        `Verification submission requires a pending citizen; citizen ${citizenId} is ${citizen.status}`,
      );
    }

    const verification = await this.createVerification({
      citizenId,
      method: input.method,
      evidenceRef: input.evidenceRef,
      outcome: input.outcome,
    });

    if (input.outcome !== "verified") {
      return { citizen, verification };
    }

    const activated = await this.activateCitizen(citizenId);
    await this.audit.emit({
      actionType: "identity.citizen_activated",
      actorRef: citizenId,
      payload: { verificationId: verification.id, method: input.method },
    });
    return { citizen: activated, verification };
  }

  // CitizenStatusChecker port (citizen-status.port.ts): AUTH-010's
  // `citizen.active` condition, checked by ProblemModule/ProposalModule
  // before problem:create, proposal:create, proposal:constraint:add,
  // proposal:budget:add, scope_challenge:file.
  async isActive(citizenId: string): Promise<boolean> {
    const citizen = await this.findCitizenById(citizenId);
    return citizen?.status === "active";
  }

  // AUTH-010 AUTH-001 `identity:read:own` -- scope "own".
  async getOwn(citizenId: string, requesterId: string): Promise<Citizen> {
    if (citizenId !== requesterId) {
      throw new ForbiddenDomainError("Citizens may only read their own civic identity");
    }
    const citizen = await this.findCitizenById(citizenId);
    if (!citizen) {
      throw new NotFoundDomainError("citizen", citizenId);
    }
    return citizen;
  }

  // System/worker-scoped status-only read (AUTH-010 identity:status:read,
  // worker-only -- NOT identity:read:own). BUG-002: auth-service
  // (apps/api-go) needs citizen.status before issuing a session, but
  // getOwn's requester-equality check can never be satisfied by a
  // service-to-service caller authenticating on the citizen's behalf --
  // making it satisfy that check would mean auth-service impersonating the
  // very citizen it's about to authenticate, a privilege inversion. This
  // route returns strictly less than getById: status only, never
  // publicHandle or legalIdentityHash (government-identifiers-never-public).
  async statusOf(citizenId: string): Promise<{ status: Citizen["status"] }> {
    const citizen = await this.prisma.forWorker((tx) => tx.citizen.findUnique({ where: { id: citizenId } }));
    if (!citizen) {
      throw new NotFoundDomainError("citizen", citizenId);
    }
    return { status: citizen.status };
  }

  private async registerCitizen(input: RegisterCitizenInput): Promise<Citizen> {
    // The duplicate check needs to see every citizen regardless of who's
    // registering, which is exactly what api_app's OWN-scoped policy denies
    // an unauthenticated caller (by design) -- this is a worker-role read,
    // same DP-024 concern (system-wide duplicate detection), not an
    // ordinary citizen request (ADR-030).
    const existing = await this.prisma.forWorker((tx) =>
      tx.citizen.findFirst({ where: { legalIdentityHash: input.legalIdentityHash, status: { not: "revoked" } } }),
    );
    if (existing) {
      throw new ConflictDomainError("A civic identity already exists for this legal identity");
    }

    try {
      // citizen_self_register's WITH CHECK(true) allows the INSERT
      // unconditionally, but Prisma's `create()` always does INSERT ...
      // RETURNING, and RETURNING is additionally gated by the SELECT policy
      // (`id = current_citizen_id()`) -- unsatisfiable for a brand-new,
      // not-yet-authenticated row. Pre-generating the id and setting
      // app.citizen_id to that same value before the INSERT makes the two
      // match, so the RETURNING read-back succeeds without weakening the
      // SELECT policy for anyone else.
      const id = randomUUID();
      return await this.prisma.forCitizen(id, (tx) =>
        tx.citizen.create({ data: { id, publicHandle: input.publicHandle, legalIdentityHash: input.legalIdentityHash } }),
      );
    } catch (err) {
      // Defense-in-depth backstop: the partial unique index
      // (citizen_legal_identity_hash_active_uidx) catches a race the
      // check above can miss under concurrency.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        throw new ConflictDomainError("A civic identity already exists for this legal identity");
      }
      throw err;
    }
  }

  // Reads run under the requesting citizen's own context elsewhere
  // (controller passes the requester's id); a bare lookup by id with no
  // acting citizen only ever returns a row when id itself is the acting
  // citizen, per the citizen_own_select policy -- callers needing a
  // worker-scoped lookup should add one explicitly rather than relying on
  // this method bypassing RLS.
  private async findCitizenById(id: string): Promise<Citizen | null> {
    return this.prisma.forCitizen(id, (tx) => tx.citizen.findUnique({ where: { id } }));
  }

  private async createVerification(input: CreateVerificationInput): Promise<IdentityVerification> {
    return this.prisma.forCitizen(input.citizenId, (tx) =>
      tx.identityVerification.create({
        data: {
          citizenId: input.citizenId,
          method: input.method,
          evidenceRef: input.evidenceRef,
          status: input.outcome,
          verifiedAt: input.outcome === "verified" ? new Date() : null,
        },
      }),
    );
  }

  private async activateCitizen(citizenId: string): Promise<Citizen> {
    // citizen:activate is a worker-only permission (AUTH-010) even though
    // DP-002 itself is citizen-triggered (ADR-030).
    return this.prisma.forWorker(async (tx) => {
      const citizen = await tx.citizen.findUnique({ where: { id: citizenId } });
      if (!citizen) {
        throw new NotFoundDomainError("citizen", citizenId);
      }
      if (citizen.status !== "pending") {
        return citizen;
      }
      return tx.citizen.update({ where: { id: citizenId }, data: { status: "active" } });
    });
  }
}
