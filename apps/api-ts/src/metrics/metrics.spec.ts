import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditEmitFailuresTotal,
  competencyExpirySweptTotal,
  governanceApprovalsSubmittedTotal,
  identityRevocationsExecutedTotal,
  register,
} from "./metrics.js";
import { metricsMiddleware } from "./metrics.middleware.js";
import { MetricsModule } from "./metrics.module.js";

describe("MetricsModule (HTTP)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MetricsModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(metricsMiddleware);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /metrics serves Prometheus exposition format and includes default process metrics", async () => {
    const res = await request(app.getHttpServer()).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("process_cpu_user_seconds_total");
  });

  it("records http_requests_total/http_request_duration_seconds for requests it serves", async () => {
    await request(app.getHttpServer()).get("/metrics");
    const res = await request(app.getHttpServer()).get("/metrics");
    expect(res.text).toMatch(/http_requests_total\{[^}]*route="\/metrics"[^}]*\} \d/);
    expect(res.text).toContain('http_request_duration_seconds_count{route="/metrics"}');
  });

  it("exposes the critical-process counters this app increments elsewhere", async () => {
    identityRevocationsExecutedTotal.inc();
    governanceApprovalsSubmittedTotal.inc({ approvalType: "audit_confirmation" });
    auditEmitFailuresTotal.inc();
    competencyExpirySweptTotal.inc(3);

    const body = await register.metrics();
    expect(body).toContain("identity_revocations_executed_total");
    expect(body).toContain("governance_approvals_submitted_total");
    expect(body).toContain("audit_emit_failures_total");
    expect(body).toContain("competency_expiry_swept_total");
  });
});
