import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { authenticatedCitizenId } from "./auth-context.js";

// Requests receive this context from auth-context middleware after auth-service
// validates their bearer session.
export const CitizenId = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined => {
  const request = ctx.switchToHttp().getRequest<Request>();
  return authenticatedCitizenId(request);
});

// @RequiredCitizenId() -- 401s when no validated bearer session exists, for
// every endpoint AUTH-010 requires an authenticated citizen for.
export const RequiredCitizenId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const citizenId = authenticatedCitizenId(request);
  if (!citizenId) {
    throw new UnauthorizedException("Missing valid bearer session");
  }
  return citizenId;
});
