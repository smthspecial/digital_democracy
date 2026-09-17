import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditActionTypeFor, HttpAuditEmitter } from "./audit-emitter.js";

// Unit tier: pure verb-mapping function, no I/O. This is what BUG-001's
// fix actually depends on -- every dotted domain verb this app emits must
// land on one of audit-service's seven TBL-034 action_type values.
describe("auditActionTypeFor", () => {
  it.each([
    ["identity.citizen_activated", "identity_event"],
    ["iam.policy_proposed", "admin_action"],
    ["iam.attachment_proposed", "admin_action"],
    ["iam.endorsement_submitted", "admin_action"],
    ["iam.revoked", "admin_action"],
    ["governance_role.approval_submitted", "admin_action"],
    ["proposal.created", "proposal_created"],
    ["problem.created", "system_update"],
    ["deliberation.argument_posted", "system_update"],
    ["reputation.delta_recorded", "system_update"],
    ["budget.ledger_entry_recorded", "system_update"],
    ["project.milestone_reported", "system_update"],
    ["project.outcome_evaluation_submitted", "system_update"],
    ["civic_duty.assignment_completed", "system_update"],
    ["civic_duty.assignment_abandoned", "system_update"],
    ["civic_duty.exemption_claimed", "system_update"],
  ])("maps %s -> %s", (verb, expected) => {
    expect(auditActionTypeFor(verb)).toBe(expected);
  });

  it("falls back to system_update for an unmapped verb rather than throwing or dropping it", () => {
    expect(auditActionTypeFor("some_future.verb_nobody_mapped_yet")).toBe("system_update");
  });
});

// Integration tier: a real local HTTP server standing in for audit-service,
// asserting the exact request BUG-001 got wrong -- path, method, and a
// snake_case body whose `payload` field is a JSON STRING (audit-service's
// real handler, apps/api-go/internal/audit/handlers.go, would 400 on
// anything else). No mocked `fetch`: this is the same request shape a real
// audit-service instance receives.
describe("HttpAuditEmitter (HTTP)", () => {
  let server: Server;
  let baseUrl: string;
  let received: { method?: string; path?: string; body?: unknown } | undefined;
  let responseStatus = 201;

  beforeEach(async () => {
    received = undefined;
    responseStatus = 201;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received = {
          method: req.method,
          path: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
        };
        res.writeHead(responseStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "test-entry" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("expected server to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
    process.env.AUDIT_SERVICE_URL = baseUrl;
  });

  afterEach(async () => {
    delete process.env.AUDIT_SERVICE_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("POSTs /audit/log (not /audit/events) with a snake_case body and a string payload", async () => {
    const emitter = new HttpAuditEmitter();
    await emitter.emit({
      actionType: "identity.citizen_activated",
      actorRef: "citizen-123",
      payload: { citizenId: "citizen-123" },
    });

    expect(received?.method).toBe("POST");
    expect(received?.path).toBe("/audit/log");
    const body = received?.body as Record<string, unknown>;
    expect(body.action_type).toBe("identity_event");
    expect(body.actor_ref).toBe("citizen-123");
    // payload must be a JSON string (audit-service hashes it and never
    // stores the plaintext) -- not the nested object BUG-001 sent.
    expect(typeof body.payload).toBe("string");
    expect(JSON.parse(body.payload as string)).toMatchObject({
      event: "identity.citizen_activated",
      citizenId: "citizen-123",
    });
  });

  it("includes idempotency_key only when the caller supplies one", async () => {
    const emitter = new HttpAuditEmitter();
    await emitter.emit({ actionType: "proposal.created", actorRef: "citizen-1", payload: {}, idempotencyKey: "evt-1" });
    expect((received?.body as Record<string, unknown>).idempotency_key).toBe("evt-1");

    await emitter.emit({ actionType: "proposal.created", actorRef: "citizen-1", payload: {} });
    expect((received?.body as Record<string, unknown>).idempotency_key).toBeUndefined();
  });

  it("does not throw when audit-service returns a non-2xx (best-effort delivery)", async () => {
    responseStatus = 400;
    const emitter = new HttpAuditEmitter();
    await expect(
      emitter.emit({ actionType: "identity.citizen_activated", actorRef: "citizen-1", payload: {} }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when audit-service is unreachable (EC-44, FR-060)", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const emitter = new HttpAuditEmitter();
    await expect(
      emitter.emit({ actionType: "identity.citizen_activated", actorRef: "citizen-1", payload: {} }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when AUDIT_SERVICE_URL is unset", async () => {
    delete process.env.AUDIT_SERVICE_URL;
    const emitter = new HttpAuditEmitter();
    await emitter.emit({ actionType: "identity.citizen_activated", actorRef: "citizen-1", payload: {} });
    expect(received).toBeUndefined();
  });
});
