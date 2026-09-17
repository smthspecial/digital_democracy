import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import {
  ConflictDomainError,
  ForbiddenDomainError,
  InvalidStateDomainError,
  NotFoundDomainError,
} from "../common/domain-errors.js";
import { GOVERNANCE_ROLE_CHECKER } from "../governance-role/governance-role-checker.port.js";
import type { GovernanceRoleChecker } from "../governance-role/governance-role-checker.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  AccessPolicy,
  AccessPolicyListFilter,
  AccessPolicyStatus,
  EvaluateAccessInput,
  EvaluateAccessResult,
  InsertEndorsementInput,
  PolicyAttachment,
  PolicyAttachmentListFilter,
  PolicyAttachmentStatus,
  PolicyEndorsement,
  PolicyEndorsementListFilter,
  PolicyEndorsementTargetType,
  ProposeAttachmentInput,
  ProposePolicyInput,
} from "./iam.types.js";

const UNIQUE_VIOLATION = "P2002";
const FOREIGN_KEY_VIOLATION = "P2003";
const RECORD_NOT_FOUND = "P2025";

// DP-069/070's "operator or platform_operator" set -- the only two role
// types iam-service's own grant flow (as opposed to revoke, which also
// accepts auditor) ever checks against.
const GRANTABLE_ROLE_TYPES = ["operator", "platform_operator"] as const;
type GrantableRoleType = (typeof GRANTABLE_ROLE_TYPES)[number];

export interface SubmitEndorsementInput {
  targetType: PolicyEndorsementTargetType;
  targetId: string;
  decision: "approved" | "rejected";
}

export interface RevokeInput {
  targetType: PolicyEndorsementTargetType;
  targetId: string;
}

// DP-069..072, SRV-018: talks to Postgres directly via PrismaService's dual
// api_app/api_worker connections (ADR-030) -- no repository indirection.
@Injectable()
export class IamService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GOVERNANCE_ROLE_CHECKER) private readonly governanceRole: GovernanceRoleChecker,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  // DP-069 (policy half). AUTH-006/AUTH-011-gated: proposer must hold an
  // active operator or platform_operator role, verified live against
  // governance-role-service's checker port (never trusted from the request
  // body, ADR-025).
  async proposePolicy(citizenId: string, input: ProposePolicyInput): Promise<AccessPolicy> {
    await this.assertGrantableRoleHolder(citizenId);
    const policy = await this.insertPolicy(citizenId, input);
    await this.audit.emit({
      actionType: "iam.policy_proposed",
      actorRef: citizenId,
      payload: { policyId: policy.id, name: policy.name, effect: policy.effect },
    });
    return policy;
  }

  // DP-069 (attachment half). Same proposer eligibility check as proposePolicy.
  async proposeAttachment(citizenId: string, input: ProposeAttachmentInput): Promise<PolicyAttachment> {
    await this.assertGrantableRoleHolder(citizenId);
    const attachment = await this.insertAttachment(citizenId, input);
    await this.audit.emit({
      actionType: "iam.attachment_proposed",
      actorRef: citizenId,
      payload: { attachmentId: attachment.id, policyId: attachment.policyId, principalRef: attachment.principalRef },
    });
    return attachment;
  }

  // access_policy_public_read is USING(true) for both roles (CON-005) -- no
  // citizen context needed.
  async listPolicies(filter?: AccessPolicyListFilter): Promise<AccessPolicy[]> {
    const rows = await this.prisma.app.accessPolicy.findMany({
      where: filter?.status ? { status: filter.status } : undefined,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toAccessPolicy);
  }

  // policy_attachment_public_read is USING(true) for both roles.
  async listAttachments(filter?: PolicyAttachmentListFilter): Promise<PolicyAttachment[]> {
    const rows = await this.prisma.app.policyAttachment.findMany({
      where: {
        ...(filter?.policyId ? { policyId: filter.policyId } : {}),
        ...(filter?.principalRef ? { principalRef: filter.principalRef } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toPolicyAttachment);
  }

  // policy_endorsement_public_read is USING(true) for both roles.
  async listEndorsements(filter?: PolicyEndorsementListFilter): Promise<PolicyEndorsement[]> {
    const rows = await this.prisma.app.policyEndorsement.findMany({
      where: {
        ...(filter?.targetType ? { targetType: filter.targetType } : {}),
        ...(filter?.targetId ? { targetId: filter.targetId } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toPolicyEndorsement);
  }

  // DP-070: dual-control endorsement. The endorser must be a different
  // citizen than the proposer, holding an active governance role of the
  // *same* role_type the proposer currently, actively holds (ARCH-024 §2 --
  // modeled on DP-068's break-glass co-approval, not DP-035's three-layer
  // approval, since none of DP-035's approval types maps to the
  // implementation layer). The first `approved` endorsement activates the
  // target; a `rejected` endorsement rejects it outright (either co-reviewer
  // can veto; no override).
  async submitEndorsement(citizenId: string, input: SubmitEndorsementInput): Promise<AccessPolicy | PolicyAttachment> {
    const target = await this.findTarget(input.targetType, input.targetId);
    if (target.status !== "pending_approval") {
      throw new InvalidStateDomainError(`${input.targetType} ${input.targetId} is not pending_approval`);
    }
    if (target.proposedBy === citizenId) {
      throw new ForbiddenDomainError("Endorser must be a different citizen than the proposer");
    }

    const sharedRoleType = await this.findSharedGrantableRoleType(target.proposedBy, citizenId);
    if (!sharedRoleType) {
      throw new ForbiddenDomainError(
        "Endorser must hold an active operator or platform_operator role matching the proposer's",
      );
    }

    // @@unique([targetType, targetId, endorserCitizenId]) -- a second
    // endorsement attempt by the same citizen on the same target surfaces
    // as ConflictDomainError from insertEndorsement; let it propagate.
    await this.insertEndorsement(citizenId, {
      targetType: input.targetType,
      targetId: input.targetId,
      decision: input.decision,
    });

    // ARCH-024 §5 says generically "a rejected decision flips it to
    // rejected", but TBL-041.md's own status enum
    // (pending_approval|active|revoked) has no `rejected` value -- only
    // TBL-040's access_policy status enum does. The table schema is the
    // authoritative source over the design doc's generalization (mirrors
    // schema.prisma's own precedent of preferring tbl-NNN.md over
    // conflicting prose elsewhere): a rejected attachment lands on
    // `revoked`, the closest terminal non-active state TBL-041 actually has.
    const updated =
      input.targetType === "policy"
        ? await this.updatePolicyStatus(input.targetId, input.decision === "approved" ? "active" : "rejected")
        : await this.updateAttachmentStatus(input.targetId, input.decision === "approved" ? "active" : "revoked");

    await this.audit.emit({
      actionType: "iam.endorsement_submitted",
      actorRef: citizenId,
      payload: { targetType: input.targetType, targetId: input.targetId, decision: input.decision },
    });

    return updated;
  }

  // DP-072: unilateral revoke, no dual control (DP-068's grant/revoke
  // asymmetry -- pulling back access is always easier than granting it).
  // Any citizen holding an active operator, platform_operator, or auditor
  // (AUTH-003) role may revoke. ADR-034 D2 (E1-12): this targets only
  // `policy`/`attachment` (PolicyEndorsementTargetType) -- an IAM
  // housekeeping action, never a citizen -- so FR-007's multi-party
  // guarantee (which ADR-034 scopes to actions removing a natural person's
  // ability to participate) does not apply here. See
  // identity-revocation.service.ts for the citizen-scoped path, which does
  // go through the approval gate.
  async revoke(citizenId: string, input: RevokeInput): Promise<AccessPolicy | PolicyAttachment> {
    const allowed = await Promise.all([
      this.governanceRole.isActiveHolder(citizenId, "operator"),
      this.governanceRole.isActiveHolder(citizenId, "platform_operator"),
      this.governanceRole.isActiveHolder(citizenId, "auditor"),
    ]);
    if (!allowed.some(Boolean)) {
      throw new ForbiddenDomainError("Revoker must hold an active operator, platform_operator, or auditor role");
    }

    const target = await this.findTarget(input.targetType, input.targetId);
    if (target.status === "revoked") {
      throw new InvalidStateDomainError(`${input.targetType} ${input.targetId} is already revoked`);
    }

    const updated =
      input.targetType === "policy"
        ? await this.updatePolicyStatus(input.targetId, "revoked")
        : await this.updateAttachmentStatus(input.targetId, "revoked");

    await this.audit.emit({
      actionType: "iam.revoked",
      actorRef: citizenId,
      payload: { targetType: input.targetType, targetId: input.targetId },
    });

    return updated;
  }

  // DP-071 (`POST /iam/evaluate`). Default-deny, explicit-deny-overrides-
  // allow (AWS IAM's own algorithm, ARCH-024 §4). Not audited -- read-path
  // traffic, unlike propose/endorse/revoke.
  async evaluate(input: EvaluateAccessInput): Promise<EvaluateAccessResult> {
    // policy_attachment_public_read is USING(true) for both roles -- no
    // citizen context needed.
    const activeAttachmentRows = await this.prisma.app.policyAttachment.findMany({
      where: { status: "active" },
      orderBy: { createdAt: "asc" },
    });
    const activeAttachments = activeAttachmentRows.map(toPolicyAttachment);
    const applicable: PolicyAttachment[] = [];
    for (const attachment of activeAttachments) {
      if (attachment.principalRef === input.principalRef) {
        applicable.push(attachment);
        continue;
      }
      const roleType = parseRoleAttachment(attachment.principalRef);
      const principalCitizenId = parseCitizenPrincipal(input.principalRef);
      if (roleType && principalCitizenId && (await this.governanceRole.isActiveHolder(principalCitizenId, roleType))) {
        applicable.push(attachment);
      }
    }

    // access_policy_public_read is USING(true) -- no citizen context needed.
    const policyRows = await Promise.all(
      applicable.map((a) => this.prisma.app.accessPolicy.findUnique({ where: { id: a.policyId } })),
    );
    const policies = policyRows.map((row) => (row ? toAccessPolicy(row) : null));
    const matched = policies.filter(
      (p): p is AccessPolicy =>
        p !== null &&
        p.status === "active" &&
        matchesWildcard(p.actions, input.action) &&
        matchesWildcard(p.resources, input.resource) &&
        matchesConditions(p.conditions, input.context),
    );

    const deny = matched.find((p) => p.effect === "deny");
    if (deny) {
      return { effect: "deny", matchedPolicyId: deny.id };
    }
    const allow = matched.find((p) => p.effect === "allow");
    if (allow) {
      return { effect: "allow", matchedPolicyId: allow.id };
    }
    return { effect: "deny", matchedPolicyId: null };
  }

  // access_policy_public_read / policy_attachment_public_read are USING(true)
  // for both roles -- no citizen context needed.
  private async findTarget(
    targetType: PolicyEndorsementTargetType,
    targetId: string,
  ): Promise<AccessPolicy | PolicyAttachment> {
    const target =
      targetType === "policy"
        ? await this.prisma.app.accessPolicy
            .findUnique({ where: { id: targetId } })
            .then((row) => (row ? toAccessPolicy(row) : null))
        : await this.prisma.app.policyAttachment
            .findUnique({ where: { id: targetId } })
            .then((row) => (row ? toPolicyAttachment(row) : null));
    if (!target) {
      throw new NotFoundDomainError(targetType, targetId);
    }
    return target;
  }

  private async assertGrantableRoleHolder(citizenId: string): Promise<void> {
    const holds = await Promise.all(
      GRANTABLE_ROLE_TYPES.map((roleType) => this.governanceRole.isActiveHolder(citizenId, roleType)),
    );
    if (!holds.some(Boolean)) {
      throw new ForbiddenDomainError("Proposer must hold an active operator or platform_operator governance role");
    }
  }

  // ARCH-024 §2's "same role_type as the proposer" -- resolved by checking,
  // for each of the two grantable role types, whether both the proposer and
  // the endorser currently, actively hold it. No "list this citizen's role
  // types" query exists on GOVERNANCE_ROLE_CHECKER (isActiveHolder is a
  // single yes/no per type), so this checks both types explicitly rather
  // than needing a broader port method.
  private async findSharedGrantableRoleType(
    proposerCitizenId: string,
    endorserCitizenId: string,
  ): Promise<GrantableRoleType | null> {
    for (const roleType of GRANTABLE_ROLE_TYPES) {
      const [proposerHolds, endorserHolds] = await Promise.all([
        this.governanceRole.isActiveHolder(proposerCitizenId, roleType),
        this.governanceRole.isActiveHolder(endorserCitizenId, roleType),
      ]);
      if (proposerHolds && endorserHolds) {
        return roleType;
      }
    }
    return null;
  }

  // access_policy_own_insert is api_app, WITH CHECK (proposed_by =
  // current_citizen_id()) -- forCitizen(citizenId, ...). The "must hold an
  // active operator/platform_operator role" half of DP-069 is checked in
  // proposePolicy before this ever runs (ARCH-024 §3: role-based, not
  // resource-ownership-based, so it can't be an RLS policy).
  private async insertPolicy(citizenId: string, input: ProposePolicyInput): Promise<AccessPolicy> {
    const row = await this.prisma.forCitizen(citizenId, (tx) =>
      tx.accessPolicy.create({
        data: {
          name: input.name,
          effect: input.effect,
          actions: input.actions,
          resources: input.resources,
          conditions: (input.conditions ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          description: input.description,
          proposedBy: citizenId,
        },
      }),
    );
    return toAccessPolicy(row);
  }

  // access_policy_worker_all (activate/reject/revoke have no proposer
  // attribution semantics of their own -- role eligibility is resolved by
  // the caller first, then this runs under _worker).
  private async updatePolicyStatus(id: string, status: AccessPolicyStatus): Promise<AccessPolicy> {
    try {
      const row = await this.prisma.forWorker((tx) => tx.accessPolicy.update({ where: { id }, data: { status } }));
      return toAccessPolicy(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === RECORD_NOT_FOUND) {
        throw new NotFoundDomainError("policy", id);
      }
      throw err;
    }
  }

  // policy_attachment_own_insert -- same shape as insertPolicy. A
  // foreign-key violation on policyId maps to NotFoundDomainError("policy",
  // policyId).
  private async insertAttachment(citizenId: string, input: ProposeAttachmentInput): Promise<PolicyAttachment> {
    try {
      const row = await this.prisma.forCitizen(citizenId, (tx) =>
        tx.policyAttachment.create({
          data: { policyId: input.policyId, principalRef: input.principalRef, proposedBy: citizenId },
        }),
      );
      return toPolicyAttachment(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundDomainError("policy", input.policyId);
      }
      throw err;
    }
  }

  // Mirrors updatePolicyStatus's worker-connection, no-proposer-attribution
  // reasoning above, for the attachment side.
  private async updateAttachmentStatus(id: string, status: PolicyAttachmentStatus): Promise<PolicyAttachment> {
    try {
      const row = await this.prisma.forWorker((tx) => tx.policyAttachment.update({ where: { id }, data: { status } }));
      return toPolicyAttachment(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === RECORD_NOT_FOUND) {
        throw new NotFoundDomainError("attachment", id);
      }
      throw err;
    }
  }

  // policy_endorsement_own_insert is api_app, WITH CHECK
  // (endorser_citizen_id = current_citizen_id()) -- forCitizen(citizenId,
  // ...). The @@unique([targetType, targetId, endorserCitizenId]) violation
  // maps to ConflictDomainError("Citizen has already endorsed this target").
  private async insertEndorsement(citizenId: string, input: InsertEndorsementInput): Promise<PolicyEndorsement> {
    try {
      const row = await this.prisma.forCitizen(citizenId, (tx) =>
        tx.policyEndorsement.create({
          data: {
            targetType: input.targetType,
            targetId: input.targetId,
            endorserCitizenId: citizenId,
            decision: input.decision,
          },
        }),
      );
      return toPolicyEndorsement(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        throw new ConflictDomainError(`Citizen ${citizenId} has already endorsed ${input.targetType} ${input.targetId}`);
      }
      throw err;
    }
  }
}

// ARCH-024 §4: exact string match, or a trailing `*` wildcard prefix match.
function matchesWildcard(entries: string[], value: string): boolean {
  return entries.some((entry) => entry === value || (entry.endsWith("*") && value.startsWith(entry.slice(0, -1))));
}

function matchesConditions(conditions: Record<string, unknown> | null, context?: Record<string, unknown>): boolean {
  if (!conditions) {
    return true;
  }
  return Object.entries(conditions).every(([key, value]) => context?.[key] === value);
}

// principal_ref shapes per ARCH-024 §1: `citizen:<uuid>` or
// `role:operator` / `role:platform_operator`.
function parseCitizenPrincipal(principalRef: string): string | null {
  const match = /^citizen:(.+)$/.exec(principalRef);
  return match ? match[1] : null;
}

function parseRoleAttachment(principalRef: string): GrantableRoleType | null {
  const match = /^role:(operator|platform_operator)$/.exec(principalRef);
  return match ? (match[1] as GrantableRoleType) : null;
}

function toAccessPolicy(row: {
  id: string;
  name: string;
  effect: AccessPolicy["effect"];
  actions: string[];
  resources: string[];
  conditions: Prisma.JsonValue;
  description: string;
  status: AccessPolicy["status"];
  proposedBy: string;
  createdAt: Date;
}): AccessPolicy {
  return {
    id: row.id,
    name: row.name,
    effect: row.effect,
    actions: row.actions,
    resources: row.resources,
    conditions: (row.conditions as Record<string, unknown> | null) ?? null,
    description: row.description,
    status: row.status,
    proposedBy: row.proposedBy,
    createdAt: row.createdAt,
  };
}

function toPolicyAttachment(row: {
  id: string;
  policyId: string;
  principalRef: string;
  status: PolicyAttachment["status"];
  proposedBy: string;
  createdAt: Date;
}): PolicyAttachment {
  return {
    id: row.id,
    policyId: row.policyId,
    principalRef: row.principalRef,
    status: row.status,
    proposedBy: row.proposedBy,
    createdAt: row.createdAt,
  };
}

function toPolicyEndorsement(row: {
  id: string;
  targetType: PolicyEndorsement["targetType"];
  targetId: string;
  endorserCitizenId: string;
  decision: PolicyEndorsement["decision"];
  createdAt: Date;
}): PolicyEndorsement {
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    endorserCitizenId: row.endorserCitizenId,
    decision: row.decision,
    createdAt: row.createdAt,
  };
}
