import { IsIn, IsOptional, IsString, IsUUID, Length } from "class-validator";
import type { DeliberationStance } from "../deliberation.types.js";

const STANCES: DeliberationStance[] = ["agreement", "disagreement"];

export class PostArgumentDto {
  @IsUUID()
  proposalId!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsIn(STANCES)
  stance!: DeliberationStance;

  @IsString()
  @Length(1, 5000)
  body!: string;

  // AUTH-010 argument:post's evidence.required condition / FR-028's "must
  // reference evidence" AC -- enforced here at the DTO layer.
  @IsString()
  @Length(1, 512)
  evidenceRef!: string;
}
