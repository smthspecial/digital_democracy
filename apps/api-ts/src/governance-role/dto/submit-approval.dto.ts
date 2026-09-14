import { IsIn, IsString, Length } from "class-validator";

// FR-061: citizen_supermajority is a vote-tally-derived value (owned by
// SRV-008/api-go's vote-counting, not an individual's assertion) -- letting
// any single citizen POST an "approved" citizen_supermajority row via this
// generic endpoint would defeat FR-061's entire point (no single entity can
// enact structural change unilaterally). So this DTO accepts only
// audit_confirmation | body_endorsement; citizen_supermajority stays a
// worker-only/system-inserted value with no HTTP path in this pass.
const SUBMITTABLE_APPROVAL_TYPES = ["audit_confirmation", "body_endorsement"] as const;

export class SubmitApprovalDto {
  @IsString()
  @Length(1, 256)
  actionRef!: string;

  @IsIn(SUBMITTABLE_APPROVAL_TYPES)
  approvalType!: "audit_confirmation" | "body_endorsement";

  @IsIn(["approved", "rejected"])
  decision!: "approved" | "rejected";
}
