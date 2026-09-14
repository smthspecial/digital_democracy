import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Query } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { DeclarePreferenceDto } from "./dto/declare-preference.dto.js";
import { PostArgumentDto } from "./dto/post-argument.dto.js";
import { DeliberationService } from "./deliberation.service.js";

// Route prefix per ADR-027 (one prefix per hosted service); resource paths
// realize each DP doc's literal trigger with the leading slash stripped.
@Controller("deliberation")
export class DeliberationController {
  constructor(@Inject(DeliberationService) private readonly deliberation: DeliberationService) {}

  // DP-008. AUTH-010 argument:post -- scope any, conditions citizen.active +
  // evidence.required.
  @Post("arguments")
  @HttpCode(HttpStatus.CREATED)
  postArgument(@RequiredCitizenId() citizenId: string, @Body() dto: PostArgumentDto) {
    return this.deliberation.postArgument(citizenId, dto);
  }

  // FR-028: structured deliberation is public -- public read, optionally
  // filtered by proposalId.
  @Get("arguments")
  findArguments(@Query("proposalId") proposalId?: string) {
    return this.deliberation.listArguments(proposalId ? { proposalId } : undefined);
  }

  // DP-009. AUTH-010 preference:declare -- scope any, condition
  // citizen.active.
  @Post("preferences")
  @HttpCode(HttpStatus.CREATED)
  declarePreference(@RequiredCitizenId() citizenId: string, @Body() dto: DeclarePreferenceDto) {
    return this.deliberation.declarePreference(citizenId, dto);
  }

  // FR-030: preferences feed proposal development -- public read,
  // optionally filtered by problemId.
  @Get("preferences")
  findPreferences(@Query("problemId") problemId?: string) {
    return this.deliberation.listPreferences(problemId ? { problemId } : undefined);
  }
}
