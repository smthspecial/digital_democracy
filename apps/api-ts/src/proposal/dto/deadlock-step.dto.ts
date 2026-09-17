import { IsString, Length } from "class-validator";

export class DeadlockStepDto {
  @IsString()
  @Length(1, 2000)
  notes!: string;
}
