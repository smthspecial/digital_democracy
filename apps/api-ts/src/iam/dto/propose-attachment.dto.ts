import { IsUUID, Matches } from "class-validator";

// ARCH-024 §1: principal_ref is `citizen:<uuid>`, `role:operator`, or
// `role:platform_operator` -- no separate principal table.
const PRINCIPAL_REF_PATTERN = /^(citizen:[0-9a-f-]{36}|role:(operator|platform_operator))$/;

export class ProposeAttachmentDto {
  @IsUUID()
  policyId!: string;

  @Matches(PRINCIPAL_REF_PATTERN, {
    message: "principalRef must be citizen:<uuid>, role:operator, or role:platform_operator",
  })
  principalRef!: string;
}
