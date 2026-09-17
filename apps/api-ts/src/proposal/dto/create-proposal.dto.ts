import { IsString, IsUUID, Length } from "class-validator";

export class CreateProposalDto {
  @IsUUID()
  problemId!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 5000)
  description!: string;
}
