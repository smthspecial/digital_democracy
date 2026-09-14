import { IsString, Length } from "class-validator";

export class RegisterCitizenDto {
  @IsString()
  @Length(3, 64)
  publicHandle!: string;

  // Raw legal identifier (e.g. a national ID number). Hashed server-side
  // (IdentityService) and never persisted or logged as-is.
  @IsString()
  @Length(1, 256)
  legalIdentifier!: string;
}
