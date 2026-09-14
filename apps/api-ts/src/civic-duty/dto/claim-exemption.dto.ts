import { IsIn, IsString, Length } from "class-validator";

// "none" is deliberately excluded -- claiming an exemption always names a
// real reason (FR-053); "none" is only ever the schema default for a
// period nobody has claimed against.
export class ClaimExemptionDto {
  @IsString()
  @Length(1, 100)
  period!: string;

  @IsIn(["illness", "disability", "military", "caregiving", "other"])
  exemptionStatus!: "illness" | "disability" | "military" | "caregiving" | "other";
}
