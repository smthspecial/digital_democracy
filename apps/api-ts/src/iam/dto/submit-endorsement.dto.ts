import { IsIn } from "class-validator";

export class SubmitEndorsementDto {
  @IsIn(["approved", "rejected"])
  decision!: "approved" | "rejected";
}
