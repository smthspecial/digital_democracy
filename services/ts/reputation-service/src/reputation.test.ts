import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { createStore } from "./store.js";
import type { ReputationRecord } from "./domain/types.js";
import type { AuditEmitter, NotificationEmitter } from "./services/reputation.js";

function buildTestServer() {
  const store = createStore();
  const notified: ReputationRecord[] = [];
  const audited: ReputationRecord[] = [];

  const notifications: NotificationEmitter = {
    notifySignificantDelta(record) {
      notified.push(record);
    },
  };
  const audit: AuditEmitter = {
    emit(_eventType, record) {
      audited.push(record);
    },
  };

  const app = buildServer({ store, notifications, audit });
  return { app, notified, audited };
}

async function postRecord(
  app: FastifyInstance,
  body: Record<string, unknown>,
) {
  return app.inject({ method: "POST", url: "/reputation/records", payload: body });
}

describe("POST /reputation/records", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it.each([
    ["accurate_prediction", 5],
    ["constructive", 3],
    ["disclosure", 8],
    ["successful_proposal", 12],
  ])("accepts positive factor_type %s with positive delta", async (factor_type, delta) => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, { citizen_id: "c1", factor_type, delta, source_ref: "" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.factor_type).toBe(factor_type);
    expect(body.delta).toBe(delta);
    expect(body.source_ref).toBeNull();
    expect(typeof body.id).toBe("string");
    expect(typeof body.created_at).toBe("string");
  });

  it.each([
    ["misinformation", -5],
    ["undisclosed_conflict", -3],
    ["manipulation", -8],
    ["fraud", -12],
  ])("accepts negative factor_type %s with negative delta and a source_ref", async (factor_type, delta) => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, { citizen_id: "c1", factor_type, delta, source_ref: "audit-finding-1" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.factor_type).toBe(factor_type);
    expect(body.delta).toBe(delta);
    expect(body.source_ref).toBe("audit-finding-1");
  });

  it.each([
    ["accurate_prediction", -5],
    ["constructive", -3],
  ])("rejects positive factor_type %s with a negative delta", async (factor_type, delta) => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, { citizen_id: "c1", factor_type, delta, source_ref: "ref" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/positive-polarity/);
  });

  it.each([
    ["misinformation", 5],
    ["fraud", 12],
  ])("rejects negative factor_type %s with a positive delta", async (factor_type, delta) => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, { citizen_id: "c1", factor_type, delta, source_ref: "ref" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/negative-polarity/);
  });

  it.each([
    ["accurate_prediction", 0],
    ["misinformation", 0],
  ])("rejects a zero delta for %s", async (factor_type, delta) => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, { citizen_id: "c1", factor_type, delta, source_ref: "ref" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a negative-polarity record with a missing source_ref", async () => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, { citizen_id: "c1", factor_type: "fraud", delta: -10 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/source_ref/);
  });

  it("rejects a negative-polarity record with an empty source_ref", async () => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, { citizen_id: "c1", factor_type: "fraud", delta: -10, source_ref: "   " });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/source_ref/);
  });

  it("accepts a positive-polarity record with an empty source_ref", async () => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, { citizen_id: "c1", factor_type: "constructive", delta: 4, source_ref: "" });
    expect(res.statusCode).toBe(201);
  });

  it("rejects an unknown factor_type via schema validation", async () => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, { citizen_id: "c1", factor_type: "bogus", delta: 5 });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing citizen_id via schema validation", async () => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, { factor_type: "constructive", delta: 5 });
    expect(res.statusCode).toBe(400);
  });

  it.each([9, -9])(
    "does not notify when abs(delta) is below the significant threshold (%d)",
    async (delta) => {
      const { app: testApp, notified, audited } = buildTestServer();
      app = testApp;
      const factor_type = delta > 0 ? "constructive" : "misinformation";
      const res = await postRecord(app, { citizen_id: "c1", factor_type, delta, source_ref: "ref" });
      expect(res.statusCode).toBe(201);
      expect(notified).toHaveLength(0);
      expect(audited).toHaveLength(1);
    },
  );

  it.each([10, -10, 15, -20])(
    "notifies when abs(delta) meets or exceeds the significant threshold (%d)",
    async (delta) => {
      const { app: testApp, notified, audited } = buildTestServer();
      app = testApp;
      const factor_type = delta > 0 ? "constructive" : "misinformation";
      const res = await postRecord(app, { citizen_id: "c1", factor_type, delta, source_ref: "ref" });
      expect(res.statusCode).toBe(201);
      expect(notified).toHaveLength(1);
      expect(audited).toHaveLength(1);
    },
  );

  it("always calls the audit emitter regardless of delta size", async () => {
    const { app: testApp, audited } = buildTestServer();
    app = testApp;
    await postRecord(app, { citizen_id: "c1", factor_type: "constructive", delta: 1, source_ref: "" });
    expect(audited).toHaveLength(1);
  });
});

describe("GET /reputation/citizens/:id", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("returns total 0 and an empty log for a citizen with no records", async () => {
    ({ app } = buildTestServer());
    const res = await app.inject({ method: "GET", url: "/reputation/citizens/unknown" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ citizen_id: "unknown", total: 0, records: [] });
  });

  it("sums deltas across multiple records of both polarities", async () => {
    ({ app } = buildTestServer());
    await postRecord(app, { citizen_id: "c1", factor_type: "constructive", delta: 5, source_ref: "" });
    await postRecord(app, { citizen_id: "c1", factor_type: "successful_proposal", delta: 20, source_ref: "" });
    await postRecord(app, { citizen_id: "c1", factor_type: "misinformation", delta: -3, source_ref: "ref" });
    await postRecord(app, { citizen_id: "c2", factor_type: "fraud", delta: -50, source_ref: "ref" });

    const res = await app.inject({ method: "GET", url: "/reputation/citizens/c1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.citizen_id).toBe("c1");
    expect(body.total).toBe(22);
    expect(body.records).toHaveLength(3);
  });
});

describe("GET /reputation/citizens/:id/records", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("returns the full event log for that citizen only", async () => {
    ({ app } = buildTestServer());
    await postRecord(app, { citizen_id: "c1", factor_type: "constructive", delta: 5, source_ref: "" });
    await postRecord(app, { citizen_id: "c1", factor_type: "misinformation", delta: -3, source_ref: "ref" });
    await postRecord(app, { citizen_id: "c2", factor_type: "fraud", delta: -50, source_ref: "ref" });

    const res = await app.inject({ method: "GET", url: "/reputation/citizens/c1/records" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body.every((r: { citizen_id: string }) => r.citizen_id === "c1")).toBe(true);
  });
});

// ABUSE-REP-1/2 (testing/e2e-api-test-plan.md): POST /reputation/records has
// no caller authentication of any kind -- every test above already posts
// directly with no credential, which is itself the first half of this
// finding (DP-038 says records should only originate from an authorized
// upstream service after a real event; the route enforces none of that).
// The second half, proven here, is that delta also has no magnitude cap: a
// citizen's whole standing can be set in one call, in either direction, by
// anyone who can reach this endpoint -- self-boosting and defaming a rival
// are the same one-line request. source_ref is required for negative
// deltas (tested elsewhere in this file) but is never checked for
// authenticity, only non-emptiness, so it doesn't close this gap either.
describe("ABUSE-REP-1/2: unauthenticated, unbounded reputation writes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("a single unauthenticated call can set an enormous positive delta for any citizen (self-boosting)", async () => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, {
      citizen_id: "attacker-controlled-citizen",
      factor_type: "successful_proposal",
      delta: 1_000_000,
      source_ref: "",
    });
    expect(res.statusCode).toBe(201);

    const total = await app.inject({ method: "GET", url: "/reputation/citizens/attacker-controlled-citizen" });
    expect(total.json().total).toBe(1_000_000);
  });

  it("a single unauthenticated call can set an enormous negative delta against a named rival (defamation), with only a non-empty (not authentic) source_ref", async () => {
    ({ app } = buildTestServer());
    const res = await postRecord(app, {
      citizen_id: "a-political-rival",
      factor_type: "fraud",
      delta: -1_000_000,
      source_ref: "trust me",
    });
    expect(res.statusCode).toBe(201);

    const total = await app.inject({ method: "GET", url: "/reputation/citizens/a-political-rival" });
    expect(total.json().total).toBe(-1_000_000);
  });
});
