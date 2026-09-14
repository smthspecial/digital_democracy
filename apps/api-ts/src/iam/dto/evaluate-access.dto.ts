import { IsObject, IsOptional, IsString, Length } from "class-validator";

// ARCH-024 §4: `POST /iam/evaluate` -- {principal_ref, action, resource,
// context?}. Not gated behind @RequiredCitizenId(): a caller passes the
// concrete principal it wants evaluated (typically a service checking
// another citizen's access, not its own), matching AUTH-012's
// service-to-service shape rather than an ordinary citizen-actor write.
export class EvaluateAccessDto {
  @IsString()
  @Length(1, 200)
  principalRef!: string;

  @IsString()
  @Length(1, 200)
  action!: string;

  @IsString()
  @Length(1, 200)
  resource!: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}
