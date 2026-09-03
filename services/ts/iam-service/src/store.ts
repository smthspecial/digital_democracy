import { randomUUID } from "node:crypto";
import type {
  AccessPolicy,
  AttachmentStatus,
  Effect,
  EndorsementDecision,
  EndorsementTargetType,
  PolicyAttachment,
  PolicyEndorsement,
  PolicyStatus,
  RoleType,
} from "./domain/types.js";

export interface CreateAccessPolicyInput {
  name: string;
  effect: Effect;
  actions: string[];
  resources: string[];
  conditions: Record<string, unknown> | null;
  description: string;
  proposedBy: string;
  proposerRoleType: RoleType;
}

export interface CreatePolicyAttachmentInput {
  policyId: string;
  principalRef: string;
  proposedBy: string;
  proposerRoleType: RoleType;
}

export interface CreatePolicyEndorsementInput {
  targetType: EndorsementTargetType;
  targetId: string;
  endorserCitizenId: string;
  decision: EndorsementDecision;
}

export function createStore() {
  const policies = new Map<string, AccessPolicy>();
  const attachments = new Map<string, PolicyAttachment>();
  const endorsements = new Map<string, PolicyEndorsement>();

  return {
    createPolicy(input: CreateAccessPolicyInput): AccessPolicy {
      const policy: AccessPolicy = {
        id: randomUUID(),
        name: input.name,
        effect: input.effect,
        actions: input.actions,
        resources: input.resources,
        conditions: input.conditions,
        description: input.description,
        status: "pending_approval",
        proposedBy: input.proposedBy,
        proposerRoleType: input.proposerRoleType,
        createdAt: new Date(),
      };
      policies.set(policy.id, policy);
      return policy;
    },

    getPolicy(id: string): AccessPolicy | undefined {
      return policies.get(id);
    },

    listPolicies(): AccessPolicy[] {
      return [...policies.values()];
    },

    setPolicyStatus(id: string, status: PolicyStatus): AccessPolicy {
      const policy = policies.get(id);
      if (!policy) {
        throw new Error(`cannot update status of unknown policy ${id}`);
      }
      const updated: AccessPolicy = { ...policy, status };
      policies.set(id, updated);
      return updated;
    },

    createAttachment(input: CreatePolicyAttachmentInput): PolicyAttachment {
      const attachment: PolicyAttachment = {
        id: randomUUID(),
        policyId: input.policyId,
        principalRef: input.principalRef,
        status: "pending_approval",
        proposedBy: input.proposedBy,
        proposerRoleType: input.proposerRoleType,
        createdAt: new Date(),
      };
      attachments.set(attachment.id, attachment);
      return attachment;
    },

    getAttachment(id: string): PolicyAttachment | undefined {
      return attachments.get(id);
    },

    listAttachments(): PolicyAttachment[] {
      return [...attachments.values()];
    },

    setAttachmentStatus(id: string, status: AttachmentStatus): PolicyAttachment {
      const attachment = attachments.get(id);
      if (!attachment) {
        throw new Error(`cannot update status of unknown attachment ${id}`);
      }
      const updated: PolicyAttachment = { ...attachment, status };
      attachments.set(id, updated);
      return updated;
    },

    createEndorsement(input: CreatePolicyEndorsementInput): PolicyEndorsement {
      const endorsement: PolicyEndorsement = {
        id: randomUUID(),
        targetType: input.targetType,
        targetId: input.targetId,
        endorserCitizenId: input.endorserCitizenId,
        decision: input.decision,
        createdAt: new Date(),
      };
      endorsements.set(endorsement.id, endorsement);
      return endorsement;
    },

    listEndorsementsForTarget(
      targetType: EndorsementTargetType,
      targetId: string,
    ): PolicyEndorsement[] {
      return [...endorsements.values()].filter(
        (endorsement) => endorsement.targetType === targetType && endorsement.targetId === targetId,
      );
    },
  };
}

export type Store = ReturnType<typeof createStore>;
