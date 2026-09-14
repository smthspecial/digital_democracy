import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
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
}
