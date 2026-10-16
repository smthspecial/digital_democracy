import { CanActivate, ExecutionContext, Inject, Injectable, Optional, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service.js";
import { SignedRequestVerifier } from "../common/internal-service.guard.js";

@Injectable()
export class IdentityVerifierGuard extends SignedRequestVerifier implements CanActivate {
  constructor(@Optional() @Inject(PrismaService) prisma?: PrismaService) { super(prisma); }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    if (!await this.verify(request, "identity-verifier", process.env.IDENTITY_VERIFIER_SHARED_SECRET)) {
      throw new UnauthorizedException("Authenticated identity verifier required");
    }
    return true;
  }
}
