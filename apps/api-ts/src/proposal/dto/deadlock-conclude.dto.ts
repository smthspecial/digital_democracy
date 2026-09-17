import { IsIn, IsString, Length } from "class-validator";

export class DeadlockConcludeDto {
  @IsIn(["approved", "rejected"])
  outcome!: "approved" | "rejected";

  @IsString()
  @Length(1, 2000)
  notes!: string;
}
