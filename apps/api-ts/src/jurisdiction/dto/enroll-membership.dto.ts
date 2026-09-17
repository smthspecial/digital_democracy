import { IsUUID } from "class-validator";

export class EnrollMembershipDto {
  @IsUUID()
  jurisdictionId!: string;
}
