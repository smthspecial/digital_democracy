// ADR-023: real async communication, proven end-to-end for audit.append
// (DP-036), the queue every service's AuditEmitter now actually publishes
// to (see ARCH-009 §2, ARCH-021's ADR-023 status update). Three real
// processes are the baseline for every scenario here: a real nats-server
// (JetStream), a real publishing service (or several), and a real
// audit-service (Go, consuming and appending to its hash chain) -- no
// mocked business logic anywhere in this chain. Beyond the original
// single-publisher proof of concept, this suite also covers: multiple real
// services sharing the one `audit.append` stream concurrently (proposal-
// service and identity-service both migrated off HTTP onto NATS, not just
// proposal-service), and the at-least-once/idempotent-write guarantee ADR-023
// promised (a duplicate delivery of the same idempotency_key must not
// double-append).
import { createHash, randomUUID } from "node:crypto";
import { connectEventBus, publish, type EventBus } from "@dd/event-bus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnGoService, spawnNatsServer, spawnTsService, type SpawnedService } from "./harness.js";

async function asJson(res: Response) {
  return JSON.parse(await res.text());
}

async function waitFor<T>(check: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await check();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return last!;
}

// AuditLogEntry (domain.go) never stores the raw payload, only its hash
// (NFR-001: "ballot content never stored here") -- so correlating a
// specific audit entry back to the proposal action that produced it means
// recomputing payload_hash the same way audit-service's chain.go does
// (sha256 of the JSON encoding) and matching on that, not on payload
// content that was never stored. audit-service decodes the payload into a
// Go map[string]any and re-marshals it to compute the hash, and Go's
// encoding/json sorts map keys alphabetically on marshal -- so the object
// key order this function is given doesn't matter, only that its keys get
// sorted the same way before hashing.
function payloadHash(payload: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key];
  }
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

describe("ADR-023 async audit queue (real nats-server + proposal-service + audit-service)", () => {
  const NATS_PORT = 48709;
  const PROPOSAL_PORT = 48714;
  const AUDIT_PORT = 48712;
  const NATS_URL = `nats://127.0.0.1:${NATS_PORT}`;
  const PROPOSAL_URL = `http://127.0.0.1:${PROPOSAL_PORT}`;
  const AUDIT_URL = `http://127.0.0.1:${AUDIT_PORT}`;

  let nats: SpawnedService;
  let audit: SpawnedService;
  let proposal: SpawnedService;

  beforeAll(async () => {
    nats = await spawnNatsServer(NATS_PORT);
    audit = await spawnGoService("audit-service", AUDIT_PORT, { NATS_URL });
    proposal = await spawnTsService("proposal-service", PROPOSAL_PORT, { NATS_URL });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([proposal?.stop(), audit?.stop(), nats?.stop()]);
  });

  async function createProposal() {
    const uid = randomUUID();
    const res = await fetch(`${PROPOSAL_URL}/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        problem_id: `problem-${uid}`,
        title: `Async audit proposal ${uid}`,
        description: "Proves proposal-service -> NATS -> audit-service end to end",
        author_id: `author-${uid}`,
      }),
    });
    return asJson(res);
  }

  async function listAuditLog(actionType: string): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${AUDIT_URL}/audit/log?action_type=${actionType}`);
    const body = await asJson(res);
    return body.entries ?? [];
  }

  it("a proposal.created event published to NATS is durably appended to audit-service's hash chain", async () => {
    const created = await createProposal();
    const expectedHash = payloadHash({ proposalId: created.id });

    const entries = await waitFor(
      () => listAuditLog("proposal_created"),
      (list) => list.some((e) => e.payload_hash === expectedHash),
    );
    const match = entries.find((e) => e.payload_hash === expectedHash);
    expect(match).toBeDefined();
    expect(match?.actor_ref).toBe("proposal-service");
    expect(match?.id).toBeTypeOf("string");
    expect(match?.prev_hash).toBeTypeOf("string");
    expect(match?.signature).toBeTypeOf("string");
  });

  it("a proposal.status_changed event flows through for a real advance() transition", async () => {
    const created = await createProposal();
    const advanceRes = await fetch(`${PROPOSAL_URL}/proposals/${created.id}/advance`, { method: "POST" });
    expect(advanceRes.status).toBe(200);
    const expectedHash = payloadHash({ proposalId: created.id, from: "draft", to: "gathering_support" });

    const entries = await waitFor(
      () => listAuditLog("proposal_status_changed"),
      (list) => list.some((e) => e.payload_hash === expectedHash),
    );
    expect(entries.some((e) => e.payload_hash === expectedHash)).toBe(true);
  });

  it("the hash chain remains valid after consuming multiple queued events", async () => {
    const before = await listAuditLog("proposal_created");
    await createProposal();
    await createProposal();

    await waitFor(() => listAuditLog("proposal_created"), (list) => list.length >= before.length + 2);

    const verifyRes = await fetch(`${AUDIT_URL}/audit/log/verify`);
    const verify = await asJson(verifyRes);
    expect(verify.valid).toBe(true);
    expect(verify.broken_at).toBeNull();
  });

  it("survives audit-service being down at publish time: the event is durably queued and appears once it's back up", async () => {
    // Stop audit-service; publish while nothing is consuming.
    await audit.stop();

    const created = await createProposal();
    const expectedHash = payloadHash({ proposalId: created.id });

    // Nothing consuming yet -- give the publish a moment before restarting,
    // so this genuinely exercises "published while down", not a timing fluke.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Restart audit-service against the same NATS server and durable
    // consumer name -- it should pick up the message that was durably
    // queued while it was down, proving JetStream's persistence (the
    // entire point of ADR-023 over the old synchronous-HTTP-that-
    // silently-drops-on-failure behavior). Its own in-memory store is
    // fresh on restart, so only messages redelivered from the queue
    // backlog can produce a match here.
    audit = await spawnGoService("audit-service", AUDIT_PORT, { NATS_URL });

    const entries = await waitFor(
      () => listAuditLog("proposal_created"),
      (list) => list.some((e) => e.payload_hash === expectedHash),
      8000,
    );
    expect(entries.some((e) => e.payload_hash === expectedHash)).toBe(true);
  });

  it("two different real services publishing to the same audit.append stream concurrently both land correctly and the chain stays valid", async () => {
    // identity-service is a second, independent real publisher onto the
    // exact same NATS stream proposal-service already uses -- proving this
    // is genuinely a shared queue eleven services now publish to (ADR-023's
    // migration), not something that only happens to work for one caller.
    const IDENTITY_PORT = 48716;
    const identity = await spawnTsService("identity-service", IDENTITY_PORT, { NATS_URL });
    try {
      const beforeCreated = await listAuditLog("identity_event");
      const beforeProposal = await listAuditLog("proposal_created");

      const uid = randomUUID();
      const [proposalRes, citizenRes] = await Promise.all([
        createProposal(),
        fetch(`http://127.0.0.1:${IDENTITY_PORT}/identity/citizens`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ public_handle: `citizen-${uid}`, raw_legal_identifier: `legal-${uid}` }),
        }).then(asJson),
      ]);
      const expectedProposalHash = payloadHash({ proposalId: proposalRes.id });

      const proposalEntries = await waitFor(
        () => listAuditLog("proposal_created"),
        (list) => list.length >= beforeProposal.length + 1 && list.some((e) => e.payload_hash === expectedProposalHash),
      );
      const identityEntries = await waitFor(
        () => listAuditLog("identity_event"),
        (list) => list.length >= beforeCreated.length + 1,
      );

      const proposalMatch = proposalEntries.find((e) => e.payload_hash === expectedProposalHash);
      expect(proposalMatch?.actor_ref).toBe("proposal-service");

      // The identity-service entry can't be correlated by payload_hash the
      // same way (registerCitizen's audit payload includes a server-
      // generated citizen id this test doesn't know ahead of the call), so
      // this asserts on what's actually checkable: a new identity_event
      // landed, attributed to the right service, and the citizen really
      // was created.
      expect(identityEntries.length).toBeGreaterThanOrEqual(beforeCreated.length + 1);
      expect(identityEntries.every((e) => e.actor_ref === "identity-service")).toBe(true);
      expect(citizenRes.public_handle).toBe(`citizen-${uid}`);

      const verifyRes = await fetch(`${AUDIT_URL}/audit/log/verify`);
      const verify = await asJson(verifyRes);
      expect(verify.valid).toBe(true);
      expect(verify.broken_at).toBeNull();
    } finally {
      await identity.stop();
    }
  }, 30_000);

  it("a duplicate delivery of the same idempotency_key (queue redelivery) produces exactly one audit entry", async () => {
    // Publishes directly onto the queue rather than through a real service's
    // business action -- this is deliberately testing the queue's own
    // at-least-once + audit-service's idempotency-key dedup (ADR-023's
    // consequence: "audit-service's existing idempotency_key handling...
    // needed no change"), not a citizen-facing flow, so ARCH-009 §2's
    // "fixtures through public APIs" rule doesn't apply here the way it
    // does for the other scenarios in this suite.
    const bus: EventBus = await connectEventBus(NATS_URL);
    try {
      const idempotencyKey = `e2e-dup-${randomUUID()}`;
      const payload = { note: idempotencyKey };
      const expectedHash = payloadHash(payload);
      const message = {
        action_type: "system_update",
        actor_ref: "e2e-duplicate-delivery-test",
        payload,
        idempotency_key: idempotencyKey,
      };

      await publish(bus, "audit.append", message);
      await publish(bus, "audit.append", message);

      const entries = await waitFor(
        () => listAuditLog("system_update"),
        (list) => list.some((e) => e.payload_hash === expectedHash),
      );
      const matches = entries.filter((e) => e.payload_hash === expectedHash);
      expect(matches).toHaveLength(1);
    } finally {
      await bus.close();
    }
  });
});
