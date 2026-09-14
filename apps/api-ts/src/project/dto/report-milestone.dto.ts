import { IsDateString, IsIn, IsNumber, IsOptional, Min } from "class-validator";

export class ReportMilestoneDto {
  @IsOptional()
  @IsDateString()
  completedAt?: string;

  @IsIn(["pending", "done", "delayed"])
  status!: "pending" | "done" | "delayed";

  // See ProjectService.reportMilestone's own note on why a spend delta is
  // accepted on this same call rather than a separate endpoint.
  @IsOptional()
  @IsNumber()
  @Min(0)
  spentDelta?: number;
}
