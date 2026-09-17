import { IsString, Length } from "class-validator";

export class AddCommentDto {
  @IsString()
  @Length(1, 5000)
  body!: string;
}
