import { IsIn, IsString, Length } from "class-validator";

export class ResolveScopeChallengeDto {
  @IsIn(["upheld", "dismissed"])
  outcome!: "upheld" | "dismissed";

  @IsString()
  @Length(1, 2000)
  resolution!: string;
}
