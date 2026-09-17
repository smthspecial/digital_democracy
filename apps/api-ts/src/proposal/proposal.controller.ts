import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { AddBudgetDto } from "./dto/add-budget.dto.js";
import { AddConstraintDto } from "./dto/add-constraint.dto.js";
import { AssignScopeDto } from "./dto/assign-scope.dto.js";
import { CreateProposalDto } from "./dto/create-proposal.dto.js";
import { DeadlockConcludeDto } from "./dto/deadlock-conclude.dto.js";
import { DeadlockStepDto } from "./dto/deadlock-step.dto.js";
import { FileScopeChallengeDto } from "./dto/file-scope-challenge.dto.js";
import { ResolveScopeChallengeDto } from "./dto/resolve-scope-challenge.dto.js";
import { DeadlockService } from "./deadlock.service.js";
import { ProposalService } from "./proposal.service.js";

// Route prefix per ADR-027 (one prefix per hosted service); resource paths
// realize each DP doc's literal trigger with the leading slash stripped.
@Controller("proposal")
export class ProposalController {
  constructor(
    @Inject(ProposalService) private readonly proposal: ProposalService,
    @Inject(DeadlockService) private readonly deadlock: DeadlockService,
  ) {}

  // DP-005. AUTH-010 proposal:create -- scope any, condition citizen.active.
  @Post("proposals")
  @HttpCode(HttpStatus.CREATED)
  create(@RequiredCitizenId() citizenId: string, @Body() dto: CreateProposalDto) {
    return this.proposal.create(citizenId, dto);
  }

  // FR-018: competing proposals on the same problem, presented side by
  // side -- public read, optionally filtered by problemId.
  @Get("proposals")
  findAll(@Query("problemId") problemId?: string) {
    return this.proposal.findAll(problemId ? { problemId } : undefined);
  }

  @Get("proposals/:id")
  findById(@Param("id") id: string) {
    return this.proposal.findById(id);
  }

  // DP-006. AUTH-010 proposal:constraint:add -- scope proposal:author.
  @Post("proposals/:id/constraints")
  @HttpCode(HttpStatus.CREATED)
  addConstraint(@Param("id") id: string, @RequiredCitizenId() citizenId: string, @Body() dto: AddConstraintDto) {
    return this.proposal.addConstraint(citizenId, id, dto);
  }

  // Public read -- "constraint sets are public" (EPIC-005).
  @Get("proposals/:id/constraints")
  listConstraints(@Param("id") id: string) {
    return this.proposal.listConstraints(id);
  }

  // DP-007. AUTH-010 proposal:budget:add -- scope proposal:author.
  @Post("proposals/:id/budget")
  @HttpCode(HttpStatus.CREATED)
  addBudget(@Param("id") id: string, @RequiredCitizenId() citizenId: string, @Body() dto: AddBudgetDto) {
    return this.proposal.addBudget(citizenId, id, dto);
  }

  // Public read -- "voters see complete funding information" (US-028).
  @Get("proposals/:id/budget")
  getBudget(@Param("id") id: string) {
    return this.proposal.getBudget(id);
  }

  // DP-020. AUTH-010 scope_challenge:file -- scope jurisdiction:affected.
  @Post("scope-challenges")
  @HttpCode(HttpStatus.CREATED)
  fileScopeChallenge(@RequiredCitizenId() citizenId: string, @Body() dto: FileScopeChallengeDto) {
    return this.proposal.fileScopeChallenge(citizenId, dto.proposalId, dto.reason);
  }

  @Get("scope-challenges")
  listScopeChallenges(@Query("proposalId") proposalId: string) {
    return this.proposal.listScopeChallenges(proposalId);
  }

  // ADR-038 D10/E2-08. Independent review-body resolution.
  @Post("scope-challenges/:id/resolve")
  resolveScopeChallenge(
    @Param("id") id: string,
    @RequiredCitizenId() reviewerId: string,
    @Body() dto: ResolveScopeChallengeDto,
  ) {
    return this.proposal.resolveScopeChallenge(reviewerId, id, dto.outcome, dto.resolution);
  }

  // ADR-038 D10/E2-05. Gated on an active review_body role.
  @Post("proposals/:id/scope")
  assignScope(@Param("id") id: string, @RequiredCitizenId() reviewerId: string, @Body() dto: AssignScopeDto) {
    return this.proposal.assignScope(reviewerId, id, dto.jurisdictionId, dto.rationale);
  }

  // DP-029/ADR-035. Author-triggered transitions only
  // (draft->gathering_support, development->voting); gathering_support->
  // development is system-triggered on threshold crossing.
  @Post("proposals/:id/advance")
  advance(@Param("id") id: string, @RequiredCitizenId() citizenId: string) {
    return this.proposal.advance(citizenId, id);
  }

  // FR-034/ADR-036 D35/E5-13..15. Reviewer-gated (proposal_review assignment).
  @Post("proposals/:id/deadlock/enter")
  @HttpCode(HttpStatus.CREATED)
  enterDeadlock(@Param("id") id: string, @RequiredCitizenId() reviewerId: string, @Body() dto: DeadlockStepDto) {
    return this.deadlock.enter(reviewerId, id, dto.notes);
  }

  @Post("proposals/:id/deadlock/advance")
  advanceDeadlock(@Param("id") id: string, @RequiredCitizenId() reviewerId: string, @Body() dto: DeadlockStepDto) {
    return this.deadlock.advance(reviewerId, id, dto.notes);
  }

  @Post("proposals/:id/deadlock/conclude")
  concludeDeadlock(@Param("id") id: string, @RequiredCitizenId() reviewerId: string, @Body() dto: DeadlockConcludeDto) {
    return this.deadlock.conclude(reviewerId, id, dto.outcome, dto.notes);
  }

  @Get("proposals/:id/deadlock/history")
  deadlockHistory(@Param("id") id: string) {
    return this.deadlock.history(id);
  }
}
