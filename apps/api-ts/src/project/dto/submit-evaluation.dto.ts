import { IsIn, IsString, Length } from "class-validator";

export class SubmitEvaluationDto {
  @IsString()
  @Length(1, 2000)
  objective!: string;

  @IsString()
  @Length(1, 2000)
  promisedOutcome!: string;

  @IsString()
  @Length(1, 2000)
  measuredOutcome!: string;

  @IsIn(["successful", "partial", "unsuccessful"])
  evaluation!: "successful" | "partial" | "unsuccessful";
}
