import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

// Interim citizen-context seam (ADR-030): auth-service (SRV-017) lives in
// apps/api-go and real session/JWT validation against it is not part of
// implementing SRV-001..004. Until that integration lands, the acting
// citizen is read directly from a header -- the same "seam, not the real
// thing yet" pattern as api-go's CompetencyChecker/AuditEmitter
// (apps/api-go/internal/delegation/service.go).
const CITIZEN_ID_HEADER = "x-citizen-id";

// @CitizenId() -- optional, undefined when the header is absent (e.g. DP-001
// registration, genuinely unauthenticated per its own DP doc).
export const CitizenId = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const value = request.headers[CITIZEN_ID_HEADER];
  return Array.isArray(value) ? value[0] : value;
});

// @RequiredCitizenId() -- 401s when the header is absent, for every endpoint
// AUTH-010 requires an authenticated citizen for.
export const RequiredCitizenId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const value = request.headers[CITIZEN_ID_HEADER];
  const citizenId = Array.isArray(value) ? value[0] : value;
  if (!citizenId) {
    throw new UnauthorizedException(`Missing ${CITIZEN_ID_HEADER} header`);
  }
  return citizenId;
});
