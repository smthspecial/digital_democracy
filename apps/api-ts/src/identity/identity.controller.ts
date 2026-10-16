import { InternalServiceGuard } from "../common/internal-service.guard.js";
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, UseGuards, Header } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { DuplicateDetectionService } from "./duplicate-detection.service.js";
import { RegisterCitizenDto } from "./dto/register-citizen.dto.js";
import { SubmitVerificationDto } from "./dto/submit-verification.dto.js";
import { IdentityService } from "./identity.service.js";
import { IdentityVerifierGuard } from "./identity-verifier.guard.js";
import { AuthProvisioner } from "./auth-provisioner.js";

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
    @Inject(AuthProvisioner) private readonly authProvisioner: AuthProvisioner,
  ) {}

  // DP-001. Unauthenticated (a civic identity does not exist yet).
  @Post("citizens")
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterCitizenDto) {
    return this.identity.register(dto);
  }

  // AUTH-010 identity:read:own -- scope "own".
  @Get("citizens/:id")
  getById(@Param("id") id: string, @RequiredCitizenId("T1") requesterId: string) {
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

  // DP-002/ADR-040: the trusted verifier supplies the evidence decision.
  // No pre-existing citizen session is needed for identity provisioning.
  @Post("citizens/:id/verifications")
  @UseGuards(IdentityVerifierGuard)
  @Header("Cache-Control", "no-store")
  @HttpCode(HttpStatus.CREATED)
  async submitVerification(@Param("id", ParseUUIDPipe) citizenId: string, @Body() dto: SubmitVerificationDto) {
    const result = await this.identity.submitVerification(citizenId, dto);
    if (result.citizen.status !== "active") return result;
    return { ...result, enrollment: await this.authProvisioner.provision(citizenId) };
  }

  // Retries after a cross-runtime outage require the trusted verifier again.
  // An active account with no verified evidence may never receive a grant.
  @Post("citizens/:id/enrollment-grant")
  @UseGuards(IdentityVerifierGuard)
  @Header("Cache-Control", "no-store")
  async enrollmentGrant(@Param("id", ParseUUIDPipe) citizenId: string) {
    await this.identity.assertVerifiedIdentity(citizenId);
    return this.authProvisioner.provision(citizenId);
  }

  // FR-005 AC3/ADR-034 D6 (E1-13). Review-facing, not auto-acting.
  @Get("duplicates/scan")
  @UseGuards(InternalServiceGuard)
  scanForDuplicateSignals() {
    return this.duplicateDetection.scanForDuplicateSignals();
  }

  @Get("registrations/burst-check")
  @UseGuards(InternalServiceGuard)
  detectRegistrationBurst() {
    return this.duplicateDetection.detectRegistrationBurst();
  }
}
