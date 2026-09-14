import { IsString, Length } from "class-validator";

export class AddConstraintDto {
  @IsString()
  @Length(1, 2000)
  text!: string;
}
