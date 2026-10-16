import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { ForbiddenDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { GOVERNANCE_ROLE_CHECKER, type GovernanceRoleChecker } from "../governance-role/governance-role-checker.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { JurisdictionMembershipChecker } from "./jurisdiction-membership.port.js";
import { Jurisdiction, JurisdictionNode } from "./jurisdiction.types.js";

// Pure, order-independent tree assembly for SRV-002's "Read jurisdiction
// tree" sync read -- exported so nesting correctness is unit-testable
// without a repository. Root nodes are jurisdictions with parentId === null;
// a jurisdiction whose parentId points outside the given set (shouldn't
// happen for a full findAll() read, but this stays defensive) surfaces as a
// root too, rather than being silently dropped.
export function buildJurisdictionTree(jurisdictions: Jurisdiction[]): JurisdictionNode[] {
  const nodes = new Map<string, JurisdictionNode>();
  for (const jurisdiction of jurisdictions) {
    nodes.set(jurisdiction.id, { ...jurisdiction, children: [] });
  }

  const roots: JurisdictionNode[] = [];
  for (const jurisdiction of jurisdictions) {
    const node = nodes.get(jurisdiction.id)!;
    const parent = jurisdiction.parentId === null ? undefined : nodes.get(jurisdiction.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// SRV-002 talks to Postgres directly via PrismaService's dual api_app/
// api_worker connections (ADR-030), with no repository indirection.
// Jurisdiction definitions remain worker-managed; citizens can declare their
// own residency/membership and reviewers decide residency verification.
@Injectable()
export class JurisdictionService implements JurisdictionMembershipChecker {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GOVERNANCE_ROLE_CHECKER) private readonly governanceRoles: GovernanceRoleChecker,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  // jurisdiction_public_read is USING(true) for both api_app and api_worker
  // (ADR-030) -- no citizen context needed.
  async getTree(): Promise<JurisdictionNode[]> {
    const jurisdictions = await this.prisma.app.jurisdiction.findMany();
    return buildJurisdictionTree(jurisdictions);
  }

  // problem:endorse's `jurisdiction:member` (AUTH-010) -- strict membership.
  // A jurisdiction_membership row exists for this exact pair (FR-013).
  // jurisdiction_membership_own_select is OWN (citizen_id =
  // current_citizen_id()); forCitizen(citizenId, ...) with citizenId as
  // both the RLS context and the filter target (the same target citizen)
  // satisfies it -- convention documented on identity.repository.prisma.ts.
  async isMember(citizenId: string, jurisdictionId: string): Promise<boolean> {
    const membership = await this.prisma.forCitizen(citizenId, (tx) =>
      tx.jurisdictionMembership.findFirst({ where: { citizenId, jurisdictionId } }),
    );
    return membership !== null;
  }

  // scope_challenge:file's `jurisdiction:affected` (AUTH-010): member OR a
  // verified resident of this jurisdiction (jurisdiction-membership.port.ts).
  async isAffected(citizenId: string, jurisdictionId: string): Promise<boolean> {
    if (await this.isMember(citizenId, jurisdictionId)) {
      return true;
    }
    // The citizen's residency row for this jurisdiction with status
    // "active", or null (FR-012). residency_own_select is OWN (citizen_id =
    // current_citizen_id()); same forCitizen trick.
    const residency = await this.prisma.forCitizen(citizenId, (tx) =>
      tx.residency.findFirst({ where: { citizenId, jurisdictionId, status: "active" } }),
    );
    return residency?.verified === true;
  }

  // JurisdictionMembershipChecker port: ADR-038 D7. Strict AND, not
  // isAffected's OR -- membership AND a verified, currently-active
  // residency whose startDate is at least minResidencyDays in the past.
  async isEligible(citizenId: string, jurisdictionId: string): Promise<boolean> {
    const [member, jurisdiction, residency] = await Promise.all([
      this.isMember(citizenId, jurisdictionId),
      this.prisma.app.jurisdiction.findUnique({ where: { id: jurisdictionId } }),
      this.prisma.forCitizen(citizenId, (tx) =>
        tx.residency.findFirst({ where: { citizenId, jurisdictionId, status: "active", verified: true } }),
      ),
    ]);
    if (!member || !jurisdiction || !residency) {
      return false;
    }
    const daysResident = (Date.now() - residency.startDate.getTime()) / (1000 * 60 * 60 * 24);
    return daysResident >= jurisdiction.minResidencyDays;
  }

  // DP-025: derive the roster rather than trusting a worker-supplied citizen list.
  // Keyset pages bound requests without excluding large jurisdictions.
  async eligibleCitizens(proposalId: string, jurisdictionId: string, after?: string) {
    if (after && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(after)) throw new BadRequestException("Invalid cursor");
    const proposal = await this.prisma.app.proposal.findUnique({ where: { id: proposalId } });
    if (!proposal || proposal.scopeJurisdictionId !== jurisdictionId || proposal.status !== "voting") {
      throw new ForbiddenDomainError("Proposal is not voting in this jurisdiction");
    }
    const rows = await this.prisma.forWorker((tx) => tx.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM citizen c
      JOIN jurisdiction_membership m ON m.citizen_id=c.id
      JOIN jurisdiction j ON j.id=m.jurisdiction_id
      WHERE j.id=${jurisdictionId}::uuid AND j.status='active'
        AND c.status='active' AND c.citizenship_status='citizen'
        AND c.id > ${after ?? "00000000-0000-0000-0000-000000000000"}::uuid
        AND EXISTS (SELECT 1 FROM residency r WHERE r.citizen_id=c.id
          AND r.jurisdiction_id=j.id AND r.status='active' AND r.verified=true
          AND r.start_date <= CURRENT_DATE-j.min_residency_days)
      ORDER BY c.id LIMIT 501`);
    return { citizen_ids: rows.slice(0, 500).map((row) => row.id),
      next_cursor: rows.length > 500 ? rows[499].id : "" };
  }

  // E2-04: no citizen-facing create op existed for residency/membership at
  // all (ADR-030 left both worker-seeded only) despite RLS already
  // supporting an own-scoped insert (residency_own_insert/
  // jurisdiction_membership_own_insert, init migration). verified defaults
  // false -- a worker-gated verification step (matching identity
  // verification's own pending->active shape) is separate, deliberately
  // out of this item's scope.
  async declareResidency(citizenId: string, jurisdictionId: string, startDate: Date): Promise<void> {
    await this.prisma.forCitizen(citizenId, (tx) =>
      tx.residency.create({ data: { citizenId, jurisdictionId, startDate, verified: false } }),
    );
  }

  async ownResidencies(citizenId: string) {
    return this.prisma.forCitizen(citizenId, (tx) => tx.residency.findMany({ where: { citizenId } }));
  }

  async pendingResidencies(reviewerId: string) {
    if (!(await this.governanceRoles.isActiveHolder(reviewerId, "reviewer"))) {
      throw new ForbiddenDomainError("Only an active reviewer may read pending residency decisions");
    }
    return this.prisma.forWorker((tx) => tx.residency.findMany({
      where: { reviewedAt: null, status: "active", citizenId: { not: reviewerId } }, take: 100,
      orderBy: { id: "asc" }, include: { citizen: { select: { publicHandle: true } }, jurisdiction: { select: { name: true } } },
    }));
  }

  // A reviewer records one immutable decision against a citizen-declared
  // residency. The explicit decision distinguishes a rejection from a
  // declaration that has not yet been reviewed, while `verified` remains the
  // efficient eligibility predicate used by existing callers.
  async reviewResidency(
    reviewerId: string,
    residencyId: string,
    decision: "verified" | "rejected",
  ): Promise<void> {
    if (!(await this.governanceRoles.isActiveHolder(reviewerId, "reviewer"))) {
      throw new ForbiddenDomainError("Only an active reviewer may decide residency verification");
    }
    const residency = await this.prisma.forWorker((tx) => tx.residency.findUnique({ where: { id: residencyId } }));
    if (!residency) {
      throw new NotFoundDomainError("residency", residencyId);
    }
    const update = await this.prisma.forWorker((tx) =>
      tx.residency.updateMany({
        // A conditional update, rather than a read followed by update,
        // preserves the one-decision rule under concurrent reviewer calls.
        where: { id: residencyId, reviewedAt: null },
        data: {
          verified: decision === "verified",
          verificationDecision: decision,
          reviewedAt: new Date(),
          reviewedByCitizenId: reviewerId,
        },
      }),
    );
    if (update.count !== 1) {
      throw new InvalidStateDomainError(`Residency ${residencyId} has already been reviewed`);
    }
    await this.audit.emit({
      actionType: "jurisdiction.residency_reviewed",
      actorRef: reviewerId,
      payload: { residencyId, citizenId: residency.citizenId, jurisdictionId: residency.jurisdictionId, decision },
      idempotencyKey: `residency-review:${residencyId}`,
    });
  }

  async enrollMembership(citizenId: string, jurisdictionId: string): Promise<void> {
    await this.prisma.forCitizen(citizenId, (tx) => tx.jurisdictionMembership.create({ data: { citizenId, jurisdictionId } }));
  }
}
