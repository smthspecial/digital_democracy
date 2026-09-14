import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { AddBudgetDto } from "./dto/add-budget.dto.js";
import { AddConstraintDto } from "./dto/add-constraint.dto.js";
import { CreateProposalDto } from "./dto/create-proposal.dto.js";
import { FileScopeChallengeDto } from "./dto/file-scope-challenge.dto.js";
import { ProposalService } from "./proposal.service.js";

// Route prefix per ADR-027 (one prefix per hosted service); resource paths
// realize each DP doc's literal trigger with the leading slash stripped.
@Controller("proposal")
export class ProposalController {
  constructor(@Inject(ProposalService) private readonly proposal: ProposalService) {}

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

  // DP-007. AUTH-010 proposal:budget:add -- scope proposal:author.
  @Post("proposals/:id/budget")
  @HttpCode(HttpStatus.CREATED)
  addBudget(@Param("id") id: string, @RequiredCitizenId() citizenId: string, @Body() dto: AddBudgetDto) {
    return this.proposal.addBudget(citizenId, id, dto);
  }

  // DP-020. AUTH-010 scope_challenge:file -- scope jurisdiction:affected.
  @Post("scope-challenges")
  @HttpCode(HttpStatus.CREATED)
  fileScopeChallenge(@RequiredCitizenId() citizenId: string, @Body() dto: FileScopeChallengeDto) {
    return this.proposal.fileScopeChallenge(citizenId, dto.proposalId);
  }
}
