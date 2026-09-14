import { IsIn, IsString, IsUUID, Length } from "class-validator";
import type { ConflictOfInterestType } from "../competency.types.js";

const TYPES: ConflictOfInterestType[] = ["employer", "ownership", "consulting", "financial"];

export class DeclareConflictDto {
  @IsUUID()
  domainId!: string;

  @IsIn(TYPES)
  type!: ConflictOfInterestType;

  @IsString()
  @Length(1, 2000)
  description!: string;
}
