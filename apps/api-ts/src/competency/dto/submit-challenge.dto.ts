import { IsIn, IsString, IsUUID, Length } from "class-validator";
import type { CompetencyChallengeReason } from "../competency.types.js";

const REASONS: CompetencyChallengeReason[] = ["credentials", "conflict", "false_claim", "misconduct"];

export class SubmitChallengeDto {
  @IsUUID()
  competencyId!: string;

  // AUTH-010 competency_challenge:submit's evidence.required condition;
  // TBL-013.md's Notes: "Evidence required; anonymous accusations rejected."
  @IsString()
  @Length(1, 512)
  evidenceRef!: string;

  @IsIn(REASONS)
  reason!: CompetencyChallengeReason;
}
