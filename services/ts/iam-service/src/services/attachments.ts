// DP-069 (propose) / DP-070 (endorse) / DP-072 (revoke) for
// policy_attachment (TBL-041) -- identical dual-control shape to
// policies.ts, against a different table. See dual-control.ts for the
// shared eligibility checks.
import type { AuditEmitter, GovernanceRoleChecker } from "../collaborators.js";
import { conflict, notFound } from "../errors.js";
import type { EndorsementDecision, PolicyAttachment, PolicyEndorsement } from "../domain/types.js";
import type { Store } from "../store.js";
import { assertCanEndorse, assertCanRevoke, resolveProposerRoleType } from "./dual-control.js";

export interface ListAttachmentsFilter {
  principalRef?: string;
}

export interface ProposeAttachmentInput {
  policyId: string;
  principalRef: string;
  proposedBy: string;
}

export interface EndorseAttachmentInput {
  endorserCitizenId: string;
  decision: EndorsementDecision;
}

export interface EndorseAttachmentResult {
  endorsement: PolicyEndorsement;
  attachment: PolicyAttachment;
}

export interface RevokeAttachmentInput {
  revokedBy: string;
}

// DP-069: same proposer-eligibility rule as proposePolicy. Also verifies
// policy_id actually names an existing access_policy (an attachment
// dangling off nothing is never useful, and DP-071's evaluation walk
// assumes store.getPolicy(attachment.policyId) resolves).
export async function proposeAttachment(
  store: Store,
  governanceRoleChecker: GovernanceRoleChecker,
  auditEmitter: AuditEmitter,
  input: ProposeAttachmentInput,
  now: Date = new Date(),
): Promise<PolicyAttachment> {
  if (!store.getPolicy(input.policyId)) {
    throw notFound(`no access_policy with id ${input.policyId}`);
  }
  const proposerRoleType = await resolveProposerRoleType(governanceRoleChecker, input.proposedBy);

  const attachment = store.createAttachment({ ...input, proposerRoleType });
  auditEmitter.emit("attachment.proposed", {
    attachmentId: attachment.id,
    policyId: attachment.policyId,
    principalRef: attachment.principalRef,
    proposedBy: attachment.proposedBy,
    proposerRoleType,
    occurredAt: now.toISOString(),
  });
  return attachment;
}

// Plain read, no eligibility check (every attachment is publicly readable,
// ADR-025/TBL-041 Notes) -- same store-filter pass-through as
// policies.ts's listPolicies.
export function listAttachments(
  store: Store,
  filter: ListAttachmentsFilter = {},
): PolicyAttachment[] {
  const attachments = store.listAttachments();
  return filter.principalRef
    ? attachments.filter((attachment) => attachment.principalRef === filter.principalRef)
    : attachments;
}

// DP-070: same dual-control rule as endorsePolicy, with one documented
// deviation -- TBL-041's status enum is pending_approval|active|revoked
// ONLY (no 'rejected', unlike TBL-040's), a gap already flagged in
// db/migrations/0001_init.up.sql's own comment on policy_attachment_status.
// A rejected endorsement decision is still recorded (and audited) here, but
// since there is no 'rejected' AttachmentStatus to flip to, the attachment
// simply stays pending_approval rather than reaching a false terminal
// state -- a different citizen holding the same role_type can still
// endorse it afterward. Flagged for spec follow-up the same way the
// migration comment already is, rather than inventing a status TBL-041
// doesn't document.
export async function endorseAttachment(
  store: Store,
  governanceRoleChecker: GovernanceRoleChecker,
  auditEmitter: AuditEmitter,
  attachmentId: string,
  input: EndorseAttachmentInput,
  now: Date = new Date(),
): Promise<EndorseAttachmentResult> {
  const attachment = store.getAttachment(attachmentId);
  if (!attachment) {
    throw notFound(`no policy_attachment with id ${attachmentId}`);
  }
  // See policies.ts's endorsePolicy for why this runs before the
  // pending_approval check: the duplicate-endorsement check must still
  // catch the same citizen calling twice regardless of current status.
  await assertCanEndorse(
    store,
    governanceRoleChecker,
    "attachment",
    attachmentId,
    attachment.proposedBy,
    attachment.proposerRoleType,
    input.endorserCitizenId,
  );
  if (attachment.status !== "pending_approval") {
    throw conflict(
      `policy_attachment ${attachmentId} is not pending approval (status: ${attachment.status})`,
    );
  }

  const endorsement = store.createEndorsement({
    targetType: "attachment",
    targetId: attachmentId,
    endorserCitizenId: input.endorserCitizenId,
    decision: input.decision,
  });

  const updated =
    input.decision === "approved"
      ? store.setAttachmentStatus(attachmentId, "active")
      : attachment; // see note above -- no 'rejected' AttachmentStatus exists; left pending_approval.

  auditEmitter.emit(input.decision === "approved" ? "attachment.activated" : "attachment.rejected", {
    attachmentId,
    endorserCitizenId: input.endorserCitizenId,
    decision: input.decision,
    occurredAt: now.toISOString(),
  });

  return { endorsement, attachment: updated };
}

// DP-072: unilateral revoke -- no dual control, same eligibility rule as
// revokePolicy.
export async function revokeAttachment(
  store: Store,
  governanceRoleChecker: GovernanceRoleChecker,
  auditEmitter: AuditEmitter,
  attachmentId: string,
  input: RevokeAttachmentInput,
  now: Date = new Date(),
): Promise<PolicyAttachment> {
  const attachment = store.getAttachment(attachmentId);
  if (!attachment) {
    throw notFound(`no policy_attachment with id ${attachmentId}`);
  }
  if (attachment.status !== "active" && attachment.status !== "pending_approval") {
    throw conflict(`cannot revoke policy_attachment ${attachmentId} with status ${attachment.status}`);
  }

  await assertCanRevoke(governanceRoleChecker, input.revokedBy);

  const revoked = store.setAttachmentStatus(attachmentId, "revoked");
  auditEmitter.emit("attachment.revoked", {
    attachmentId,
    revokedBy: input.revokedBy,
    occurredAt: now.toISOString(),
  });
  return revoked;
}
