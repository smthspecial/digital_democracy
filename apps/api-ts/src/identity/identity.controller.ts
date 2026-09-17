import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { DuplicateDetectionService } from "./duplicate-detection.service.js";
import { RegisterCitizenDto } from "./dto/register-citizen.dto.js";
import { SubmitVerificationDto } from "./dto/submit-verification.dto.js";
import { IdentityService } from "./identity.service.js";

// Route prefix per ADR-027 (one prefix per hosted service).
//
// Every constructor dependency in this app is injected via an explicit
// @Inject(token) rather than bare constructor-parameter typing: Nest's
// implicit injection resolves types from `design:paramtypes` metadata, which
// requires TypeScript's `emitDecoratorMetadata`. `tsc` emits it; so does swc
// (which is why dev/test use @swc-node/register/unplugin-swc instead of
// esbuild-based tools, which don't) -- but explicit tokens are the most
// portable way to state every dependency, so this app uses them everywhere
// regardless of which of those is transforming the file at the time.
@Controller("identity")
export class IdentityController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(DuplicateDetectionService) private readonly duplicateDetection: DuplicateDetectionService,
  ) {}

  // DP-001. Unauthenticated (a civic identity does not exist yet).
  @Post("citizens")
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterCitizenDto) {
    return this.identity.register(dto);
  }

  // AUTH-010 identity:read:own -- scope "own".
  @Get("citizens/:id")
  getById(@Param("id") id: string, @RequiredCitizenId() requesterId: string) {
    return this.identity.getOwn(id, requesterId);
  }

  // BUG-002: system/worker-scoped status-only read, deliberately NOT gated
  // by @RequiredCitizenId/getOwn's requester-equality check -- the caller
  // is auth-service (apps/api-go's httpIdentityChecker), asking about a
  // citizen who is mid-login and so has no session/requester identity of
  // their own yet. Returns strictly less than getById.
  @Get("citizens/:id/status")
  statusOf(@Param("id") id: string) {
    return this.identity.statusOf(id);
  }

  // DP-002. actor: "citizen (status pending)" -- the acting citizen is
  // always the requester, never a body field (mirrors the identity_verification
  // OWN RLS policy: citizen_id = current_citizen_id()).
  @Post("verifications")
  @HttpCode(HttpStatus.CREATED)
  submitVerification(@RequiredCitizenId() citizenId: string, @Body() dto: SubmitVerificationDto) {
    return this.identity.submitVerification(citizenId, dto);
  }

  // FR-005 AC3/ADR-034 D6 (E1-13). Review-facing, not auto-acting.
  @Get("duplicates/scan")
  scanForDuplicateSignals() {
    return this.duplicateDetection.scanForDuplicateSignals();
  }

  @Get("registrations/burst-check")
  detectRegistrationBurst() {
    return this.duplicateDetection.detectRegistrationBurst();
  }
}
