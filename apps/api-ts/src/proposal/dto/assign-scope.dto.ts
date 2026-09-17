import { IsString, IsUUID, Length } from "class-validator";

export class AssignScopeDto {
  @IsUUID()
  jurisdictionId!: string;

  @IsString()
  @Length(1, 2000)
  rationale!: string;
}
