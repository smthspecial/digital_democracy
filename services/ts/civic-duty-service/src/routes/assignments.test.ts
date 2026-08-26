import { describe, expect, it, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";

function fixedRandom(...values: number[]) {
  let i = 0;
  return () => {
    const v = values[i % values.length]!;
    i += 1;
    return v;
  };
}

describe("POST /civic-duty/assignments/generate", () => {
  it("creates an assignment for exactly one candidate and returns the computed weights", async () => {
    const store = createStore();
    const app = buildServer({ store, random: fixedRandom(0) });

    const res = await app.inject({
      method: "POST",
      url: "/civic-duty/assignments/generate",
      payload: {
        type: "proposal_review",
        target_ref: "proposal-123",
        candidates: [
          { citizen_id: "c1", sphere_relevant: true, competency_match: false },
          { citizen_id: "c2", sphere_relevant: false, competency_match: false },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.assignment.status).toBe("assigned");
    expect(body.assignment.type).toBe("proposal_review");
    expect(body.assignment.targetRef).toBe("proposal-123");
    expect(["c1", "c2"]).toContain(body.assignment.citizenId);
    expect(body.weights).toHaveLength(2);
    await app.close();
  });

  it("rejects a request with no candidates", async () => {
    const app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/civic-duty/assignments/generate",
      payload: { type: "proposal_review", target_ref: "t1", candidates: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an unknown assignment type", async () => {
    const app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/civic-duty/assignments/generate",
      payload: {
        type: "not_a_real_type",
        target_ref: "t1",
        candidates: [{ citizen_id: "c1", sphere_relevant: false, competency_match: false }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("assignment status transitions", () => {
  async function seedAssignment(app: ReturnType<typeof buildServer>) {
    const res = await app.inject({
      method: "POST",
      url: "/civic-duty/assignments/generate",
      payload: {
        type: "proposal_review",
        target_ref: "t1",
        candidates: [{ citizen_id: "c1", sphere_relevant: false, competency_match: false }],
      },
    });
    return res.json().assignment.id as string;
  }

  it("accept keeps the assignment assigned", async () => {
    const app = buildServer({ random: fixedRandom(0) });
    const id = await seedAssignment(app);
    const res = await app.inject({ method: "POST", url: `/civic-duty/assignments/${id}/accept` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("assigned");
    await app.close();
  });

  it("abandon moves the assignment to abandoned", async () => {
    const app = buildServer({ random: fixedRandom(0) });
    const id = await seedAssignment(app);
    const res = await app.inject({ method: "POST", url: `/civic-duty/assignments/${id}/abandon` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("abandoned");
    await app.close();
  });

  it("complete moves the assignment to completed", async () => {
    const app = buildServer({ random: fixedRandom(0) });
    const id = await seedAssignment(app);
    const res = await app.inject({ method: "POST", url: `/civic-duty/assignments/${id}/complete` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");
    await app.close();
  });

  it("returns 404 for an unknown assignment id", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "POST", url: "/civic-duty/assignments/does-not-exist/accept" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 409 when completing an already-abandoned assignment", async () => {
    const app = buildServer({ random: fixedRandom(0) });
    const id = await seedAssignment(app);
    await app.inject({ method: "POST", url: `/civic-duty/assignments/${id}/abandon` });
    const res = await app.inject({ method: "POST", url: `/civic-duty/assignments/${id}/complete` });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe("GET /civic-duty/citizens/:id/assignments", () => {
  it("lists assignments belonging to the citizen only", async () => {
    const app = buildServer({ random: fixedRandom(0) });
    await app.inject({
      method: "POST",
      url: "/civic-duty/assignments/generate",
      payload: {
        type: "proposal_review",
        target_ref: "t1",
        candidates: [{ citizen_id: "c1", sphere_relevant: false, competency_match: false }],
      },
    });
    await app.inject({
      method: "POST",
      url: "/civic-duty/assignments/generate",
      payload: {
        type: "proposal_review",
        target_ref: "t2",
        candidates: [{ citizen_id: "c2", sphere_relevant: false, competency_match: false }],
      },
    });

    const res = await app.inject({ method: "GET", url: "/civic-duty/citizens/c1/assignments" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].citizenId).toBe("c1");
    await app.close();
  });

  it("returns an empty array for a citizen with no assignments", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/civic-duty/citizens/nobody/assignments" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });
});

describe("POST /civic-duty/assignments/rebalance", () => {
  it("classifies overloaded and underloaded citizens from their current open-assignment counts", async () => {
    const store = createStore();
    store.createAssignment({
      citizenId: "over",
      type: "proposal_review",
      targetRef: "t1",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    });
    store.createAssignment({
      citizenId: "over",
      type: "proposal_review",
      targetRef: "t2",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    });
    const app = buildServer({ store });

    const res = await app.inject({
      method: "POST",
      url: "/civic-duty/assignments/rebalance",
      payload: { candidates: ["over", "empty"], overload_threshold: 1 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ overloaded: ["over"], underloaded: ["empty"] });
    await app.close();
  });
});

describe("POST /civic-duty/audit-pool/refresh", () => {
  it("never double-assigns a citizen who already holds an open audit_review assignment", async () => {
    const store = createStore();
    store.createAssignment({
      citizenId: "already-auditing",
      type: "audit_review",
      targetRef: "existing",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    });
    const app = buildServer({ store, random: fixedRandom(0) });

    const res = await app.inject({
      method: "POST",
      url: "/civic-duty/audit-pool/refresh",
      payload: { candidates: ["already-auditing", "eligible"], count: 5 },
    });

    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toHaveLength(1);
    expect(created[0].citizenId).toBe("eligible");
    expect(created[0].type).toBe("audit_review");
    await app.close();
  });
});
