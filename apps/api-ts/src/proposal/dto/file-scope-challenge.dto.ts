import { IsUUID } from "class-validator";

export class FileScopeChallengeDto {
  @IsUUID()
  proposalId!: string;
}
