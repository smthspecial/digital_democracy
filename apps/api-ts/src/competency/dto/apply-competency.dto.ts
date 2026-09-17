import { IsInt, IsString, IsUUID, Length, Max, Min } from "class-validator";

export class ApplyCompetencyDto {
  @IsUUID()
  domainId!: string;

  // ADR-037 D29: level 0 ("General Citizen") is implicit for everyone with
  // no competency row -- an application conferring nothing only pollutes
  // the pipeline. TBL-012.md's "0-4" range is the stored range, not the
  // applicable one.
  @IsInt()
  @Min(1)
  @Max(4)
  level!: number;

  @IsString()
  @Length(1, 2000)
  evidenceRef!: string;
}
