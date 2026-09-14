import { Inject, Injectable } from "@nestjs/common";
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

// SRV-002 (ADR-030 "Jurisdiction module is read-only in this pass"): talks
// to Postgres directly via PrismaService's dual api_app/api_worker
// connections (ADR-030) -- no repository indirection. jurisdiction /
// residency / jurisdiction_membership rows are seeded directly, not
// created through any method here.
@Injectable()
export class JurisdictionService implements JurisdictionMembershipChecker {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
}
