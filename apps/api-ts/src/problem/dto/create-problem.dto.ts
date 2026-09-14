import { IsString, IsUUID, Length } from "class-validator";

export class CreateProblemDto {
  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 5000)
  description!: string;

  @IsString()
  @Length(1, 500)
  affectedArea!: string;

  @IsUUID()
  jurisdictionId!: string;
}
