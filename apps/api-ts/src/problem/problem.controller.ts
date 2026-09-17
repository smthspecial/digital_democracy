import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { AddCommentDto } from "./dto/add-comment.dto.js";
import { AddEvidenceDto } from "./dto/add-evidence.dto.js";
import { CreateProblemDto } from "./dto/create-problem.dto.js";
import { ProblemService } from "./problem.service.js";

// Route prefix per ADR-027 (one prefix per hosted service); resource paths
// realize each DP doc's literal trigger with the leading slash stripped.
@Controller("problem")
export class ProblemController {
  constructor(@Inject(ProblemService) private readonly problem: ProblemService) {}

  // DP-003. AUTH-010 problem:create -- scope any, condition citizen.active.
  @Post("problems")
  @HttpCode(HttpStatus.CREATED)
  submit(@RequiredCitizenId() citizenId: string, @Body() dto: CreateProblemDto) {
    return this.problem.submit(citizenId, dto);
  }

  // FR-016: submitted problems are public immediately -- public read.
  @Get("problems")
  findAll() {
    return this.problem.findAll();
  }

  @Get("problems/:id")
  findById(@Param("id") id: string) {
    return this.problem.findById(id);
  }

  // DP-004. AUTH-010 problem:endorse -- scope jurisdiction:member.
  @Post("problems/:id/support")
  @HttpCode(HttpStatus.CREATED)
  endorse(@Param("id") id: string, @RequiredCitizenId() citizenId: string) {
    return this.problem.endorse(citizenId, id);
  }

  // E3-02.
  @Post("problems/:id/evidence")
  @HttpCode(HttpStatus.CREATED)
  addEvidence(@Param("id") id: string, @RequiredCitizenId() citizenId: string, @Body() dto: AddEvidenceDto) {
    return this.problem.addEvidence(citizenId, id, dto.kind, dto.ref);
  }

  @Get("problems/:id/evidence")
  listEvidence(@Param("id") id: string) {
    return this.problem.listEvidence(id);
  }

  // E3-04/US-011.
  @Post("problems/:id/comments")
  @HttpCode(HttpStatus.CREATED)
  addComment(@Param("id") id: string, @RequiredCitizenId() citizenId: string, @Body() dto: AddCommentDto) {
    return this.problem.addComment(citizenId, id, dto.body);
  }

  @Get("problems/:id/comments")
  listComments(@Param("id") id: string) {
    return this.problem.listComments(id);
  }
}
