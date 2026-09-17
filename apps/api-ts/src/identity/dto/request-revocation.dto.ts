import { IsIn, IsString, IsUUID, Length } from "class-validator";

export class RequestRevocationDto {
  @IsUUID()
  citizenId!: string;

  @IsIn(["death", "loss_of_citizenship", "proven_fraud"])
  reason!: "death" | "loss_of_citizenship" | "proven_fraud";

  @IsString()
  @Length(1, 2000)
  justification!: string;
}
