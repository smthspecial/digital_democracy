import { IsInt, IsUUID, Max, Min } from "class-validator";

export class ApplyCompetencyDto {
  @IsUUID()
  domainId!: string;

  // TBL-012.md: "0-4 competency level".
  @IsInt()
  @Min(0)
  @Max(4)
  level!: number;
}
