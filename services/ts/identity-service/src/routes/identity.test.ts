import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { AuditEmitter, AuditEvent } from "../collaborators.js";
import { createDefaultDuplicateSignal, createDefaultIdentityHasher } from "../collaborators.js";
import type { IdentityServiceDeps } from "../services/identity.js";

function buildTestServer(overrides: Partial<IdentityServiceDeps> = {}): FastifyInstance {
  return buildServer({
    store: createStore(),
    hasher: createDefaultIdentityHasher(),
    approvalGate: { hasRequiredApprovals: () => true },
    audit: { append: () => {} },
    duplicateSignal: createDefaultDuplicateSignal(),
    ...overrides,
  });
}

function createSpyAudit(): { audit: AuditEmitter; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { audit: { append: (event) => events.push(event) }, events };
}

async function registerCitizen(
  app: FastifyInstance,
  overrides: Partial<{ public_handle: string; raw_legal_identifier: string }> = {},
) {
  const res = await app.inject({
    method: "POST",
    url: "/identity/citizens",
    payload: {
      public_handle: overrides.public_handle ?? "alice",
      raw_legal_identifier: overrides.raw_legal_identifier ?? "raw-id-1",
    },
  });
  return res;
}

let currentApp: FastifyInstance | undefined;

afterEach(async () => {
  await currentApp?.close();
  currentApp = undefined;
});

describe("POST /identity/citizens", () => {
  it("registers a new citizen with status pending", async () => {
    const app = (currentApp = buildTestServer());
    const res = await registerCitizen(app, { public_handle: "alice" });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.public_handle).toBe("alice");
    expect(body.status).toBe("pending");
    expect(typeof body.id).toBe("string");
    expect(typeof body.created_at).toBe("string");
  });

  it("rejects an exact duplicate legal identifier with 409", async () => {
    const app = (currentApp = buildTestServer());
    await registerCitizen(app, { public_handle: "alice", raw_legal_identifier: "same-id" });
    const res = await registerCitizen(app, { public_handle: "bob", raw_legal_identifier: "same-id" });

    expect(res.statusCode).toBe(409);
  });

  it("never leaks the raw legal identifier in the response body", async () => {
    const app = (currentApp = buildTestServer());
    const res = await registerCitizen(app, { raw_legal_identifier: "top-secret-ssn" });

    expect(JSON.stringify(res.json())).not.toContain("top-secret-ssn");
  });

  it("never leaks the raw legal identifier across the full lifecycle of responses", async () => {
    const app = (currentApp = buildTestServer());
    const rawId = "top-secret-ssn-2";
    const created = await registerCitizen(app, { raw_legal_identifier: rawId });
    const id = created.json().id as string;

    const responses = await Promise.all([
      app.inject({ method: "GET", url: `/identity/citizens/${id}` }),
      app.inject({ method: "GET", url: "/identity/citizens" }),
      app.inject({
        method: "POST",
        url: `/identity/citizens/${id}/verifications`,
        payload: { evidence_ref: "ref-1", outcome: "verified" },
      }),
      app.inject({ method: "POST", url: "/identity/duplicates/scan" }),
    ]);

    for (const res of responses) {
      expect(JSON.stringify(res.json())).not.toContain(rawId);
    }
  });
});

describe("GET /identity/citizens", () => {
  it("lists registered citizens", async () => {
    const app = (currentApp = buildTestServer());
    await registerCitizen(app, { public_handle: "alice", raw_legal_identifier: "id-a" });
    await registerCitizen(app, { public_handle: "bob", raw_legal_identifier: "id-b" });

    const res = await app.inject({ method: "GET", url: "/identity/citizens" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });
});

describe("GET /identity/citizens/:id", () => {
  it("returns the citizen by id", async () => {
    const app = (currentApp = buildTestServer());
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const res = await app.inject({ method: "GET", url: `/identity/citizens/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it("returns 404 for an unknown citizen", async () => {
    const app = (currentApp = buildTestServer());
    const res = await app.inject({ method: "GET", url: "/identity/citizens/00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /identity/citizens/:id/verifications", () => {
  it("activates the citizen on the first verified record", async () => {
    const app = (currentApp = buildTestServer());
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const res = await app.inject({
      method: "POST",
      url: `/identity/citizens/${id}/verifications`,
      payload: { evidence_ref: "ref-1", outcome: "verified" },
    });
    expect(res.statusCode).toBe(201);

    const citizenRes = await app.inject({ method: "GET", url: `/identity/citizens/${id}` });
    expect(citizenRes.json().status).toBe("active");
  });

  it("does not activate the citizen on a rejected record", async () => {
    const app = (currentApp = buildTestServer());
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    await app.inject({
      method: "POST",
      url: `/identity/citizens/${id}/verifications`,
      payload: { evidence_ref: "ref-1", outcome: "rejected" },
    });

    const citizenRes = await app.inject({ method: "GET", url: `/identity/citizens/${id}` });
    expect(citizenRes.json().status).toBe("pending");
  });

  it("does not re-run activation on a second verified record", async () => {
    const { audit, events } = createSpyAudit();
    const app = (currentApp = buildTestServer({ audit }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    await app.inject({
      method: "POST",
      url: `/identity/citizens/${id}/verifications`,
      payload: { evidence_ref: "ref-1", outcome: "verified" },
    });
    const res2 = await app.inject({
      method: "POST",
      url: `/identity/citizens/${id}/verifications`,
      payload: { evidence_ref: "ref-2", outcome: "verified" },
    });

    expect(res2.statusCode).toBe(201);
    const citizenRes = await app.inject({ method: "GET", url: `/identity/citizens/${id}` });
    expect(citizenRes.json().status).toBe("active");
    expect(events.filter((e) => e.action === "activated")).toHaveLength(1);
  });

  it("returns 404 when submitting a verification for an unknown citizen", async () => {
    const app = (currentApp = buildTestServer());
    const res = await app.inject({
      method: "POST",
      url: "/identity/citizens/00000000-0000-0000-0000-000000000000/verifications",
      payload: { evidence_ref: "ref-1", outcome: "verified" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe.each([
  { action: "suspend" as const, expectedStatus: "suspended" },
  { action: "revoke" as const, expectedStatus: "revoked" },
])("POST /identity/citizens/:id/$action", ({ action, expectedStatus }) => {
  it(`blocks ${action} without required approvals (403)`, async () => {
    const app = (currentApp = buildTestServer({ approvalGate: { hasRequiredApprovals: () => false } }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const res = await app.inject({ method: "POST", url: `/identity/citizens/${id}/${action}` });
    expect(res.statusCode).toBe(403);
  });

  it(`allows ${action} with required approvals`, async () => {
    const app = (currentApp = buildTestServer({ approvalGate: { hasRequiredApprovals: () => true } }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const res = await app.inject({ method: "POST", url: `/identity/citizens/${id}/${action}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(expectedStatus);
  });
});

describe("POST /identity/duplicates/scan", () => {
  it("flags citizens sharing the same legal_identity_hash", async () => {
    const store = createStore();
    const app = (currentApp = buildTestServer({ store }));
    const now = new Date();
    store.insertCitizen({ id: "c1", publicHandle: "alice", legalIdentityHash: "hash-x", status: "pending", createdAt: now });
    store.insertCitizen({ id: "c2", publicHandle: "carl", legalIdentityHash: "hash-x", status: "pending", createdAt: now });
    store.insertCitizen({ id: "c3", publicHandle: "dana", legalIdentityHash: "hash-y", status: "pending", createdAt: now });

    const res = await app.inject({ method: "POST", url: "/identity/duplicates/scan" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hash_matches).toHaveLength(1);
    expect(body.hash_matches[0].citizen_ids.sort()).toEqual(["c1", "c2"]);
  });

  it("flags citizens matching the default heuristic (normalized public_handle) even with different hashes", async () => {
    const store = createStore();
    const app = (currentApp = buildTestServer({ store }));
    const now = new Date();
    store.insertCitizen({ id: "c1", publicHandle: "Alice", legalIdentityHash: "hash-a", status: "pending", createdAt: now });
    store.insertCitizen({ id: "c2", publicHandle: " alice ", legalIdentityHash: "hash-b", status: "pending", createdAt: now });

    const res = await app.inject({ method: "POST", url: "/identity/duplicates/scan" });
    const body = res.json();
    expect(body.signal_matches).toEqual([{ citizen_id_a: "c1", citizen_id_b: "c2" }]);
    expect(body.hash_matches).toHaveLength(0);
  });

  it("returns empty groups when there are no duplicates", async () => {
    const app = (currentApp = buildTestServer());
    await registerCitizen(app, { public_handle: "alice", raw_legal_identifier: "id-a" });
    await registerCitizen(app, { public_handle: "bob", raw_legal_identifier: "id-b" });

    const res = await app.inject({ method: "POST", url: "/identity/duplicates/scan" });
    const body = res.json();
    expect(body.hash_matches).toHaveLength(0);
    expect(body.signal_matches).toHaveLength(0);
  });
});
