import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { AssignmentRequester, AuditEmitter, AuditEvent } from "../integrations.js";

function createFakeAssignmentRequester() {
  const requested: string[] = [];
  const requester: AssignmentRequester = {
    request: (projectId: string) => requested.push(projectId),
  };
  return { requester, requested };
}

function createFakeAuditEmitter() {
  const events: AuditEvent[] = [];
  const emitter: AuditEmitter = {
    emit: (event: AuditEvent) => events.push(event),
  };
  return { emitter, events };
}

async function createProject(
  app: FastifyInstance,
  overrides: Partial<{
    proposal_id: string;
    contractor: string;
    budget_allocated: number;
    objective: string;
    promised_outcome: string;
    milestones: { title: string; due_date: string; order_index: number }[];
  }> = {},
) {
  const res = await app.inject({
    method: "POST",
    url: "/",
    payload: {
      proposal_id: "proposal-1",
      contractor: "Acme Builders",
      budget_allocated: 10000,
      objective: "Improve neighborhood green space",
      promised_outcome: "A new park",
      milestones: [
        { title: "Design", due_date: "2026-01-01", order_index: 0 },
        { title: "Build", due_date: "2026-02-01", order_index: 1 },
      ],
      ...overrides,
    },
  });
  return res;
}

let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

describe("POST /", () => {
  it("creates a project with status active, its milestones, and an outcome evaluation", async () => {
    app = buildServer({ store: createStore() });
    const res = await createProject(app);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("active");
    expect(body.contractor).toBe("Acme Builders");
    expect(body.budget_allocated).toBe(10000);
    expect(body.budget_spent).toBe(0);
    expect(body.milestones).toHaveLength(2);
    expect(body.milestones[0].status).toBe("pending");
    expect(body.outcome_evaluation.promised_outcome).toBe("A new park");
    expect(body.outcome_evaluation.measured_outcome).toBeNull();
  });

  it("rejects a body missing required fields", async () => {
    app = buildServer({ store: createStore() });
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: { contractor: "Acme Builders" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeDefined();
  });
});

describe("GET /:id and GET /", () => {
  it("returns a 404 for an unknown project", async () => {
    app = buildServer({ store: createStore() });
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });

  it("exposes contractor and status without any auth", async () => {
    app = buildServer({ store: createStore() });
    const created = await createProject(app);
    const { id } = created.json();

    const res = await app.inject({ method: "GET", url: `/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().contractor).toBe("Acme Builders");
  });

  it("lists all created projects", async () => {
    app = buildServer({ store: createStore() });
    await createProject(app);
    await createProject(app, { proposal_id: "proposal-2" });

    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });
});

describe("GET /:id/milestones", () => {
  it("exposes milestone data without any auth, ordered by order_index", async () => {
    app = buildServer({ store: createStore() });
    const created = await createProject(app);
    const { id } = created.json();

    const res = await app.inject({ method: "GET", url: `/${id}/milestones` });
    expect(res.statusCode).toBe(200);
    const milestones = res.json();
    expect(milestones).toHaveLength(2);
    expect(milestones[0].title).toBe("Design");
    expect(milestones[1].title).toBe("Build");
  });

  it("returns 404 when the project does not exist", async () => {
    app = buildServer({ store: createStore() });
    const res = await app.inject({
      method: "GET",
      url: "/does-not-exist/milestones",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /:id/milestones/:milestoneId/complete", () => {
  it("completing a non-final milestone leaves the project active", async () => {
    app = buildServer({ store: createStore() });
    const created = await createProject(app);
    const { id, milestones } = created.json();

    const res = await app.inject({
      method: "POST",
      url: `/${id}/milestones/${milestones[0].id}/complete`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().milestone.status).toBe("done");
    expect(res.json().project.status).toBe("active");
  });

  it("completing the final milestone flips the project to completed", async () => {
    const { emitter, events } = createFakeAuditEmitter();
    app = buildServer({ store: createStore(), auditEmitter: emitter });
    const created = await createProject(app);
    const { id, milestones } = created.json();

    await app.inject({
      method: "POST",
      url: `/${id}/milestones/${milestones[0].id}/complete`,
    });
    const res = await app.inject({
      method: "POST",
      url: `/${id}/milestones/${milestones[1].id}/complete`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().project.status).toBe("completed");

    const getRes = await app.inject({ method: "GET", url: `/${id}` });
    expect(getRes.json().status).toBe("completed");
    expect(events.some((e) => e.type === "project.completed")).toBe(true);
  });

  it("rejects completing the same milestone twice", async () => {
    app = buildServer({ store: createStore() });
    const created = await createProject(app);
    const { id, milestones } = created.json();

    await app.inject({
      method: "POST",
      url: `/${id}/milestones/${milestones[0].id}/complete`,
    });
    const res = await app.inject({
      method: "POST",
      url: `/${id}/milestones/${milestones[0].id}/complete`,
    });

    expect(res.statusCode).toBe(409);
  });
});

describe("POST /:id/budget-spent", () => {
  it("increments budget_spent", async () => {
    app = buildServer({ store: createStore() });
    const created = await createProject(app);
    const { id } = created.json();

    const res = await app.inject({
      method: "POST",
      url: `/${id}/budget-spent`,
      payload: { amount: 2500, description: "First contractor invoice" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().budget_spent).toBe(2500);

    const res2 = await app.inject({
      method: "POST",
      url: `/${id}/budget-spent`,
      payload: { amount: 1000, description: "Second invoice" },
    });
    expect(res2.json().budget_spent).toBe(3500);
  });

  it("rejects a non-positive amount", async () => {
    app = buildServer({ store: createStore() });
    const created = await createProject(app);
    const { id } = created.json();

    const res = await app.inject({
      method: "POST",
      url: `/${id}/budget-spent`,
      payload: { amount: 0, description: "invalid" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("mirrors the spend into budget-service's public ledger via LedgerRecorder (TBL-028)", async () => {
    const recorded: { projectId: string; amount: number; description: string }[] = [];
    app = buildServer({
      store: createStore(),
      ledgerRecorder: {
        recordOutflow: (projectId, amount, description) =>
          recorded.push({ projectId, amount, description }),
      },
    });
    const created = await createProject(app);
    const { id } = created.json();

    await app.inject({
      method: "POST",
      url: `/${id}/budget-spent`,
      payload: { amount: 2500, description: "First contractor invoice" },
    });

    expect(recorded).toEqual([{ projectId: id, amount: 2500, description: "First contractor invoice" }]);
  });

  // ABUSE-FIN-3 (.spec/technical/test-plans/tp-001.md, ARCH-017 EC-16): recordBudgetSpent never
  // compares the running budget_spent total against budget_allocated -- the
  // only validation is "amount must be positive" (the test above). A caller
  // with legitimate access to this endpoint (an "operator", per srv-013.md's
  // intent, though nothing here actually checks that either) can record
  // spend arbitrarily far past what was allocated, and each call mirrors
  // straight into budget-service's public ledger as a seemingly-legitimate
  // outflow with no warning, no gate, no audit distinction from a normal
  // spend. This test proves there is no ceiling, not that one is missing by
  // assumption -- if this starts failing, an overspend guard has been added
  // and this test (and the finding) should be revisited.
  it("ABUSE-FIN-3: records spend far beyond budget_allocated with no ceiling check", async () => {
    app = buildServer({ store: createStore() });
    const created = await createProject(app, { budget_allocated: 10000 });
    const { id } = created.json();

    const res = await app.inject({
      method: "POST",
      url: `/${id}/budget-spent`,
      payload: { amount: 500000, description: "wildly exceeds the allocated 10000" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().budget_spent).toBe(500000);
    expect(res.json().budget_allocated).toBe(10000);
  });
});

async function completeAllMilestones(app: FastifyInstance, projectId: string, milestoneIds: string[]) {
  for (const milestoneId of milestoneIds) {
    await app.inject({
      method: "POST",
      url: `/${projectId}/milestones/${milestoneId}/complete`,
    });
  }
}

describe("POST /outcome-evaluations/sweep", () => {
  it("only requests an assignment for completed projects past the configured delay", async () => {
    const { requester, requested } = createFakeAssignmentRequester();
    app = buildServer({ store: createStore(), assignmentRequester: requester });

    const created = await createProject(app);
    const { id, milestones } = created.json();
    await completeAllMilestones(
      app,
      id,
      milestones.map((m: { id: string }) => m.id),
    );

    const tooSoon = await app.inject({
      method: "POST",
      url: "/outcome-evaluations/sweep",
      payload: { evaluation_delay_days: 180 },
    });
    expect(tooSoon.json().requested_project_ids).toEqual([]);
    expect(requested).toEqual([]);

    const later = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/outcome-evaluations/sweep",
      payload: { now: later, evaluation_delay_days: 180 },
    });
    expect(res.json().requested_project_ids).toEqual([id]);
    expect(requested).toEqual([id]);
  });

  it("does not call the assignment requester a second time for the same project", async () => {
    const { requester, requested } = createFakeAssignmentRequester();
    app = buildServer({ store: createStore(), assignmentRequester: requester });

    const created = await createProject(app);
    const { id, milestones } = created.json();
    await completeAllMilestones(
      app,
      id,
      milestones.map((m: { id: string }) => m.id),
    );

    const later = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString();
    await app.inject({
      method: "POST",
      url: "/outcome-evaluations/sweep",
      payload: { now: later, evaluation_delay_days: 180 },
    });
    const secondRun = await app.inject({
      method: "POST",
      url: "/outcome-evaluations/sweep",
      payload: { now: later, evaluation_delay_days: 180 },
    });

    expect(secondRun.json().requested_project_ids).toEqual([]);
    expect(requested).toEqual([id]);
  });

  it("does not fire for projects that are not completed", async () => {
    const { requester, requested } = createFakeAssignmentRequester();
    app = buildServer({ store: createStore(), assignmentRequester: requester });
    await createProject(app);

    const later = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/outcome-evaluations/sweep",
      payload: { now: later },
    });

    expect(res.json().requested_project_ids).toEqual([]);
    expect(requested).toEqual([]);
  });
});

describe("POST /outcome-evaluations/:id/submit", () => {
  it("sets measured_outcome and evaluation, visible on subsequent reads", async () => {
    app = buildServer({ store: createStore() });
    const created = await createProject(app);
    const { id, outcome_evaluation: outcomeEvaluation } = created.json();

    const res = await app.inject({
      method: "POST",
      url: `/outcome-evaluations/${outcomeEvaluation.id}/submit`,
      payload: { measured_outcome: "Park was built on time", evaluation: "successful" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().measured_outcome).toBe("Park was built on time");
    expect(res.json().evaluation).toBe("successful");

    const getRes = await app.inject({ method: "GET", url: `/${id}/milestones` });
    expect(getRes.statusCode).toBe(200);
  });

  it("returns 404 for an unknown evaluation id", async () => {
    app = buildServer({ store: createStore() });
    const res = await app.inject({
      method: "POST",
      url: "/outcome-evaluations/does-not-exist/submit",
      payload: { measured_outcome: "x", evaluation: "successful" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a second submission for the same evaluation", async () => {
    app = buildServer({ store: createStore() });
    const created = await createProject(app);
    const { outcome_evaluation: outcomeEvaluation } = created.json();

    await app.inject({
      method: "POST",
      url: `/outcome-evaluations/${outcomeEvaluation.id}/submit`,
      payload: { measured_outcome: "First submission", evaluation: "partial" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/outcome-evaluations/${outcomeEvaluation.id}/submit`,
      payload: { measured_outcome: "Second submission", evaluation: "partial" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("rejects a body with an invalid evaluation value", async () => {
    app = buildServer({ store: createStore() });
    const created = await createProject(app);
    const { outcome_evaluation: outcomeEvaluation } = created.json();

    const res = await app.inject({
      method: "POST",
      url: `/outcome-evaluations/${outcomeEvaluation.id}/submit`,
      payload: { measured_outcome: "x", evaluation: "great" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("credits the proposal author's reputation on a successful evaluation (DP-038)", async () => {
    const events: { citizenId: string; factorType: string; delta: number; sourceRef: string }[] = [];
    app = buildServer({
      store: createStore(),
      proposalAuthorLookup: { getAuthorId: async () => "citizen-author-1" },
      reputationEmitter: {
        emit: (citizenId, factorType, delta, sourceRef) =>
          events.push({ citizenId, factorType, delta, sourceRef }),
      },
    });
    const created = await createProject(app);
    const { id, outcome_evaluation: outcomeEvaluation } = created.json();

    await app.inject({
      method: "POST",
      url: `/outcome-evaluations/${outcomeEvaluation.id}/submit`,
      payload: { measured_outcome: "Park was built on time", evaluation: "successful" },
    });

    expect(events).toEqual([
      { citizenId: "citizen-author-1", factorType: "successful_proposal", delta: 15, sourceRef: id },
    ]);
  });

  it("does not credit reputation for a partial or unsuccessful evaluation", async () => {
    const events: unknown[] = [];
    app = buildServer({
      store: createStore(),
      proposalAuthorLookup: { getAuthorId: async () => "citizen-author-1" },
      reputationEmitter: { emit: (...args) => events.push(args) },
    });
    const created = await createProject(app);
    const { outcome_evaluation: outcomeEvaluation } = created.json();

    await app.inject({
      method: "POST",
      url: `/outcome-evaluations/${outcomeEvaluation.id}/submit`,
      payload: { measured_outcome: "Delayed", evaluation: "unsuccessful" },
    });

    expect(events).toEqual([]);
  });

  it("does not credit reputation when the proposal author cannot be resolved", async () => {
    const events: unknown[] = [];
    app = buildServer({
      store: createStore(),
      proposalAuthorLookup: { getAuthorId: async () => null },
      reputationEmitter: { emit: (...args) => events.push(args) },
    });
    const created = await createProject(app);
    const { outcome_evaluation: outcomeEvaluation } = created.json();

    const res = await app.inject({
      method: "POST",
      url: `/outcome-evaluations/${outcomeEvaluation.id}/submit`,
      payload: { measured_outcome: "Park was built on time", evaluation: "successful" },
    });

    expect(res.statusCode).toBe(200);
    expect(events).toEqual([]);
  });
});
