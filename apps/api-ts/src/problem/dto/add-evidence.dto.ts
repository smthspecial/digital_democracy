import { IsIn, IsString, Length } from "class-validator";

export class AddEvidenceDto {
  @IsIn(["document", "link", "statement"])
  kind!: "document" | "link" | "statement";

  @IsString()
  @Length(1, 2000)
  ref!: string;
}
