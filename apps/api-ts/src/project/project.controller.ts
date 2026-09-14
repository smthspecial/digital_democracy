import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { ReportMilestoneDto } from "./dto/report-milestone.dto.js";
import { SubmitEvaluationDto } from "./dto/submit-evaluation.dto.js";
import { ProjectService } from "./project.service.js";
import type { ProjectStatus } from "./project.types.js";

// Route prefix per ADR-027; resource paths realize DP-018/DP-022's literal
// triggers ("PATCH /milestones/:id", "POST /evaluations") with the leading
// slash stripped and nested under this service's own prefix.
@Controller("projects")
export class ProjectController {
  constructor(@Inject(ProjectService) private readonly project: ProjectService) {}

  // FR-046/047: public real-time oversight, optionally filtered by status.
  @Get()
  listProjects(@Query("status") status?: ProjectStatus) {
    return this.project.listProjects(status ? { status } : undefined);
  }

  @Get(":id")
  getProject(@Param("id") id: string) {
    return this.project.getProject(id);
  }

  @Get(":id/milestones")
  listMilestones(@Param("id") id: string) {
    return this.project.listMilestones({ projectId: id });
  }

  @Get(":id/evaluations")
  listEvaluations(@Param("id") id: string) {
    return this.project.listEvaluations({ projectId: id });
  }

  // DP-018. AUTH-009: AUTH-005 (oversight) or AUTH-006 (operator).
  @Patch("milestones/:id")
  reportMilestone(@RequiredCitizenId() citizenId: string, @Param("id") id: string, @Body() dto: ReportMilestoneDto) {
    return this.project.reportMilestone(citizenId, id, {
      status: dto.status,
      completedAt: dto.completedAt ? new Date(dto.completedAt) : undefined,
      spentDelta: dto.spentDelta,
    });
  }

  // DP-022. AUTH-009: AUTH-003 (auditor) or AUTH-005 (oversight).
  @Post(":id/evaluations")
  submitEvaluation(@RequiredCitizenId() citizenId: string, @Param("id") id: string, @Body() dto: SubmitEvaluationDto) {
    return this.project.submitEvaluation(citizenId, id, dto);
  }
}
