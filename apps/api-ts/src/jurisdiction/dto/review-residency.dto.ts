import { IsIn } from "class-validator";

export class ReviewResidencyDto {
  @IsIn(["verified", "rejected"])
  decision!: "verified" | "rejected";
}
