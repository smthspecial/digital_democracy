import { Controller, Get, HttpCode, HttpStatus, Inject, InternalServerErrorException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

// No route prefix, matching apps/api-go's main.go contract byte-for-byte
// (`GET /healthz` -> {"status":"ok"}, `GET /readyz` -> {"status":"ready"})
// so one readiness poller (the cross-runtime e2e harness) works unmodified
// against both apps.
@Controller()
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // Liveness: process is up and serving HTTP. No dependency checks --
  // matches api-go's healthz, which never touches Postgres either.
  @Get("healthz")
  @HttpCode(HttpStatus.OK)
  healthz() {
    return { status: "ok" };
  }

  // Readiness: both Prisma connections (app AND worker -- PrismaService
  // opens two separate pools against two separate Postgres roles, and a
  // harness that only checked one would race the other's connect() on
  // first request). A failed query throws 500 rather than returning
  // ready:false, so a load balancer's readiness probe treats it as not
  // ready without needing to parse the body.
  @Get("readyz")
  @HttpCode(HttpStatus.OK)
  async readyz() {
    try {
      await Promise.all([this.prisma.app.$queryRaw`SELECT 1`, this.prisma.worker.$queryRaw`SELECT 1`]);
    } catch (err) {
      throw new InternalServerErrorException(`not ready: ${(err as Error).message}`);
    }
    return { status: "ready" };
  }
}
