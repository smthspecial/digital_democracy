import { IsIn, IsString, IsUUID, Length } from "class-validator";

export class CreateProblemDto {
  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 5000)
  description!: string;

  @IsString()
  @Length(1, 500)
  affectedArea!: string;

  @IsUUID()
  jurisdictionId!: string;

  // ADR-035 D18: required at submission -- kind=statement lets a citizen's
  // own account satisfy this without a document.
  @IsIn(["document", "link", "statement"])
  evidenceKind!: "document" | "link" | "statement";

  @IsString()
  @Length(1, 2000)
  evidenceRef!: string;
}
