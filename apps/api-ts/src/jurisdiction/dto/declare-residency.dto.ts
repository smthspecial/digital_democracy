import { IsDateString, IsUUID } from "class-validator";

export class DeclareResidencyDto {
  @IsUUID()
  jurisdictionId!: string;

  @IsDateString()
  startDate!: string;
}
