import { IsIn, IsString, Length } from "class-validator";
import type { VerificationMethod, VerificationOutcome } from "../identity.types.js";

const METHODS: VerificationMethod[] = ["national_id", "passport", "gov_credential"];
const OUTCOMES: VerificationOutcome[] = ["verified", "rejected"];

export class SubmitVerificationDto {
  @IsIn(METHODS)
  method!: VerificationMethod;

  @IsString()
  @Length(1, 512)
  evidenceRef!: string;

  @IsIn(OUTCOMES)
  outcome!: VerificationOutcome;
}
