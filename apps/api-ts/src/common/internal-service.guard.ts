import { CanActivate, ExecutionContext, Inject, Injectable, Optional, UnauthorizedException } from "@nestjs/common";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service.js";

export function serviceHeaders(method: string, path: string, body = ""): Record<string, string> {
  const secret = process.env.INTERNAL_SERVICE_SHARED_SECRET;
  if (!secret) throw new Error("Internal service authentication is not configured");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const digest = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret).update(`api-ts\n${method}\n${path}\n${timestamp}\n${nonce}\n${digest}`).digest("hex");
  return { "x-dd-service": "api-ts", "x-dd-timestamp": timestamp, "x-dd-nonce": nonce, "x-dd-signature": signature };
}

// The memory tier is only for isolated controller tests. The real AppModule
// provides PrismaService, making replay consumption persistent across replicas.
@Injectable()
export class SignedRequestVerifier {
  private readonly seen = new Map<string, number>();
  constructor(@Optional() @Inject(PrismaService) private readonly prisma?: PrismaService) {}

  async verify(request: Request & { rawBody?: Buffer }, expectedService: string, secret?: string): Promise<boolean> {
    const timestamp = request.header("x-dd-timestamp") ?? "";
    const signature = request.header("x-dd-signature") ?? "";
    const nonce = request.header("x-dd-nonce");
    if (!secret || request.header("x-dd-service") !== expectedService || !/^\d+$/.test(timestamp) ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(signature) ||
        !nonce || !/^[a-f0-9]{32}$/.test(nonce)) return false;
    const body = request.rawBody ?? Buffer.alloc(0);
    const digest = createHash("sha256").update(body).digest("hex");
    const prefix = `${expectedService}\n${request.method}\n${request.originalUrl}\n${timestamp}\n${nonce ? nonce + "\n" : ""}`;
    const expected = createHmac("sha256", secret).update(prefix + digest).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return false;
    const key = expectedService + ":" + signature;
    const expires = (Number(timestamp) + 300) * 1000;
    if (this.prisma) {
      return this.prisma.forWorker(async (tx) => {
        await tx.$executeRaw`DELETE FROM security_request WHERE expires_at < now()`;
        const inserted = await tx.$executeRaw`INSERT INTO security_request (signature_hash,expires_at)
          VALUES (${key},${new Date(expires)}) ON CONFLICT DO NOTHING`;
        return inserted === 1;
      });
    }
    for (const [key, expiry] of this.seen) if (expiry < Date.now()) this.seen.delete(key);
    if (this.seen.has(key) || this.seen.size >= 10000) return false;
    this.seen.set(key, expires);
    return true;
  }
}

@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(@Inject(SignedRequestVerifier) private readonly verifier: SignedRequestVerifier) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    if (!await this.verifier.verify(request, "api-go", process.env.INTERNAL_SERVICE_SHARED_SECRET)) {
      throw new UnauthorizedException("Authenticated service required");
    }
    return true;
  }
}
