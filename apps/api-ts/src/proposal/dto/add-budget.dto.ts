import { IsNumber, IsOptional, IsString, IsUUID, Length, Min } from "class-validator";

// DP-007: create-or-update, so every field is optional -- a caller may add
// budget info incrementally across multiple calls.
export class AddBudgetDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  fundingSource?: string;

  @IsOptional()
  @IsUUID()
  fundingCategoryId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maintenanceCost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  longTermCost?: number;

  @IsOptional()
  @IsString()
  @Length(1, 5000)
  expectedBenefits?: string;
}
