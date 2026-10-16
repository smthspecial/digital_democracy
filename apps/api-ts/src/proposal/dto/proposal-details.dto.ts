import { IsString, Length } from "class-validator";

export class ProposalDetailsDto {
  @IsString() @Length(1, 5000) objectives!: string;
  @IsString() @Length(1, 5000) measurableOutcomes!: string;
  @IsString() @Length(1, 5000) implementationTimeline!: string;
}
