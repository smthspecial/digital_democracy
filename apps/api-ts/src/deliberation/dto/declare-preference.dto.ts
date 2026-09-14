import { IsString, IsUUID, Length } from "class-validator";

export class DeclarePreferenceDto {
  @IsUUID()
  problemId!: string;

  @IsString()
  @Length(1, 2000)
  desiredOutcome!: string;
}
