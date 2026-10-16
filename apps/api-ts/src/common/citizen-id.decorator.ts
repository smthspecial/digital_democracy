import { createParamDecorator, ExecutionContext, UnauthorizedException, ForbiddenException } from "@nestjs/common";
import type { Request } from "express";
import { authenticatedCitizenId, type AuthenticatedRequest } from "./auth-context.js";

// Requests receive this context from auth-context middleware after auth-service
// validates their bearer session.
export const CitizenId = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined => {
  const request = ctx.switchToHttp().getRequest<Request>();
  return authenticatedCitizenId(request);
});

// @RequiredCitizenId() -- 401s when no validated bearer session exists, for
// every endpoint AUTH-010 requires an authenticated citizen for.
export const RequiredCitizenId = createParamDecorator((minimum: "T1" | "T2" | "T3" = "T2", ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const citizenId = authenticatedCitizenId(request);
  if (!citizenId) {
    throw new UnauthorizedException("Missing valid bearer session");
  }
  const tier = (request as AuthenticatedRequest).auth?.assuranceTier;
  if (!tier || !["T1", "T2", "T3"].includes(tier) || tier < minimum) {
    throw new ForbiddenException({ error: { code: "step_up_required", message: "Fresh authentication required" } });
  }
  return citizenId;
});
