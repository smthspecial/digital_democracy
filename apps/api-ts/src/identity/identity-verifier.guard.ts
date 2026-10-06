import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

// A verifier is a trusted adapter (government credential or assisted review),
// with a key separate from citizen tokens and the api-ts/api-go shared key.
@Injectable()
export class IdentityVerifierGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const secret = process.env.IDENTITY_VERIFIER_SHARED_SECRET;
    const timestamp = request.header("x-dd-timestamp") ?? "";
    const service = request.header("x-dd-service");
    const signature = request.header("x-dd-signature") ?? "";
    if (!secret || !request.rawBody || service !== "identity-verifier" || !/^\d+$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(signature)) {
      throw new UnauthorizedException("Authenticated identity verifier required");
    }
    const hash = createHash("sha256").update(request.rawBody).digest("hex");
    const expected = createHmac("sha256", secret).update(`${request.method}\n${request.path}\n${timestamp}\n${hash}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
      throw new UnauthorizedException("Invalid verifier signature");
    }
    return true;
  }
}
