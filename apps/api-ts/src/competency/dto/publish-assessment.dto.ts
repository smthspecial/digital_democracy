import { IsInt, IsString, IsUUID, Length, Max, Min } from "class-validator";

// TBL-015.md doesn't state exact bounds for these smallint scores -- 0-10 is
// a reasonable documented judgment call (distinct from competency.level's
// own documented 0-4 scale).
export class PublishAssessmentDto {
  @IsUUID()
  proposalId!: string;

  @IsUUID()
  domainId!: string;

  @IsInt()
  @Min(0)
  @Max(10)
  technicalScore!: number;

  @IsInt()
  @Min(0)
  @Max(10)
  economicScore!: number;

  @IsInt()
  @Min(0)
  @Max(10)
  socialScore!: number;

  @IsInt()
  @Min(0)
  @Max(10)
  sustainabilityScore!: number;

  @IsString()
  @Length(1, 5000)
  body!: string;
}
