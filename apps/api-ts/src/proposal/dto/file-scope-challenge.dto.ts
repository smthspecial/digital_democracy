import { IsString, IsUUID, Length } from "class-validator";

export class FileScopeChallengeDto {
  @IsUUID()
  proposalId!: string;

  @IsString()
  @Length(1, 2000)
  reason!: string;
}
