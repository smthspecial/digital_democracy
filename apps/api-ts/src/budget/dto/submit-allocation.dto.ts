import { Type } from "class-transformer";
import { IsArray, IsNumber, IsString, IsUUID, Length, Max, Min, ValidateNested } from "class-validator";

export class AllocationEntryDto {
  @IsUUID()
  categoryId!: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  percentage!: number;
}

// DP-013: `allocations` may be an empty array -- SRV-007's "clear my
// allocation for this period" call (BudgetService.submitAllocation's
// totals:100 bypass) -- so no @ArrayMinSize(1), unlike a typical
// nested-array DTO.
export class SubmitAllocationDto {
  @IsString()
  @Length(1, 100)
  period!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationEntryDto)
  allocations!: AllocationEntryDto[];
}
