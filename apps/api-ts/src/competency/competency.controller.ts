import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Query } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { CompetencyService } from "./competency.service.js";
import { ApplyCompetencyDto } from "./dto/apply-competency.dto.js";
import { DeclareConflictDto } from "./dto/declare-conflict.dto.js";
import { PublishAssessmentDto } from "./dto/publish-assessment.dto.js";
import { SubmitChallengeDto } from "./dto/submit-challenge.dto.js";

// Route prefix per ADR-027 (one prefix per hosted service); resource paths
// realize each DP doc's literal trigger with the leading slash stripped.
@Controller("competency")
export class CompetencyController {
  constructor(@Inject(CompetencyService) private readonly competency: CompetencyService) {}

  // Public read -- reference data (expert_domain).
  @Get("domains")
  listDomains() {
    return this.competency.listDomains();
  }

  // DP-011. AUTH-010 competency:apply -- scope any, condition citizen.active.
  @Post("competencies")
  @HttpCode(HttpStatus.CREATED)
  apply(@RequiredCitizenId() citizenId: string, @Body() dto: ApplyCompetencyDto) {
    return this.competency.apply(citizenId, dto);
  }

  // Public read, optionally filtered by citizenId/domainId.
  @Get("competencies")
  listCompetencies(@Query("citizenId") citizenId?: string, @Query("domainId") domainId?: string) {
    return this.competency.listCompetencies(citizenId || domainId ? { citizenId, domainId } : undefined);
  }

  // DP-010. AUTH-010 coi:declare -- scope own, condition citizen.active.
  @Post("conflicts")
  @HttpCode(HttpStatus.CREATED)
  declareConflict(@RequiredCitizenId() citizenId: string, @Body() dto: DeclareConflictDto) {
    return this.competency.declareConflict(citizenId, dto);
  }

  // DP-012. AUTH-010 competency_challenge:submit -- scope any, conditions
  // citizen.active + evidence.required.
  @Post("competency-challenges")
  @HttpCode(HttpStatus.CREATED)
  submitChallenge(@RequiredCitizenId() citizenId: string, @Body() dto: SubmitChallengeDto) {
    return this.competency.submitChallenge(citizenId, dto);
  }

  // DP-021. AUTH-002 assessment:publish -- scope domain:match, conditions
  // citizen.active, competency.active, coi.none.
  @Post("assessments")
  @HttpCode(HttpStatus.CREATED)
  publishAssessment(@RequiredCitizenId() citizenId: string, @Body() dto: PublishAssessmentDto) {
    return this.competency.publish(citizenId, dto);
  }

  // Public read, optionally filtered by proposalId.
  @Get("assessments")
  listAssessments(@Query("proposalId") proposalId?: string) {
    return this.competency.listAssessments(proposalId ? { proposalId } : undefined);
  }
}
