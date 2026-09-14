import { IsInt, IsPositive, IsString, IsUUID, Length } from "class-validator";

export class CreateProposalDto {
  @IsUUID()
  problemId!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 5000)
  description!: string;

  // No population/config table backs support_threshold in this schema pass
  // (DP-030's impact scope assignment, out of scope) -- accepted as a
  // required client-supplied field rather than derived.
  @IsInt()
  @IsPositive()
  supportThreshold!: number;
}
