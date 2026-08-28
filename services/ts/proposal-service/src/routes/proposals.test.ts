import { describe, expect, it, vi, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, type Deps } from "../server.js";
import { createStore } from "../store.js";
import {
  defaultAuditEmitter,
  defaultConstitutionalReviewer,
} from "../integrations.js";

function build(overrides: Partial<Deps> = {}) {
  return buildServer({ store: createStore(), ...overrides });
}

async function createProposal(
  app: FastifyInstance,
  overrides: Partial<{
    problem_id: string;
    title: string;
    description: string;
    author_id: string;
  }> = {},
) {
  const res = await app.inject({
    method: "POST",
    url: "/proposals",
    payload: {
      problem_id: "problem-1",
      title: "Fix the potholes",
      description: "Repave Main Street",
      author_id: "citizen-1",
      ...overrides,
    },
  });
  return res;
}

describe("proposal routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe("POST /proposals", () => {
    it("creates a proposal in draft status", async () => {
      app = build();
      const res = await createProposal(app);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        problem_id: "problem-1",
        title: "Fix the potholes",
        description: "Repave Main Street",
        author_id: "citizen-1",
        status: "draft",
        support_count: 0,
        support_threshold: null,
        scope_jurisdiction_id: null,
        scope_challenge_pending: false,
      });
      expect(body.id).toBeTypeOf("string");
      expect(body.created_at).toBeTypeOf("string");
    });

    it("rejects a body missing required fields", async () => {
      app = build();
      const res = await app.inject({
        method: "POST",
        url: "/proposals",
        payload: { title: "no problem id" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("allows multiple proposals to share the same problem_id", async () => {
      app = build();
      const first = await createProposal(app, { title: "Option A" });
      const second = await createProposal(app, { title: "Option B" });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(first.json().problem_id).toBe(second.json().problem_id);
      expect(first.json().id).not.toBe(second.json().id);
    });
  });

  describe("GET /proposals and GET /proposals/:id", () => {
    it("lists created proposals and reads one by id", async () => {
      app = build();
      const created = (await createProposal(app)).json();

      const list = await app.inject({ method: "GET", url: "/proposals" });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toHaveLength(1);

      const one = await app.inject({
        method: "GET",
        url: `/proposals/${created.id}`,
      });
      expect(one.statusCode).toBe(200);
      expect(one.json().id).toBe(created.id);
    });

    it("404s reading an unknown proposal", async () => {
      app = build();
      const res = await app.inject({
        method: "GET",
        url: "/proposals/does-not-exist",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /proposals/:id/constraints", () => {
    it.each(["draft", "gathering_support", "development"] as const)(
      "allows adding a constraint while status is %s",
      async (status) => {
        app = build();
        const proposal = await advanceTo(app, status);
        const res = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/constraints`,
          payload: { author_id: "citizen-1", text: "Must be wheelchair accessible" },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().constraints).toHaveLength(1);
        expect(res.json().constraints[0]).toMatchObject({
          author_id: "citizen-1",
          text: "Must be wheelchair accessible",
          agreed: false,
        });
      },
    );

    it.each(["voting", "approved", "rejected", "archived"] as const)(
      "rejects adding a constraint while status is %s",
      async (status) => {
        app = build();
        const proposal = await advanceTo(app, status);
        const res = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/constraints`,
          payload: { author_id: "citizen-1", text: "too late" },
        });
        expect(res.statusCode).toBe(409);
        const read = await app.inject({
          method: "GET",
          url: `/proposals/${proposal.id}`,
        });
        expect(read.json().constraints).toHaveLength(0);
      },
    );
  });

  describe("PUT /proposals/:id/budget", () => {
    it("merges partial updates incrementally", async () => {
      app = build();
      const created = (await createProposal(app)).json();

      const first = await app.inject({
        method: "PUT",
        url: `/proposals/${created.id}/budget`,
        payload: { cost: 1000, funding_source: "general fund" },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().budget).toMatchObject({
        cost: 1000,
        funding_source: "general fund",
        maintenance_cost: null,
        expected_benefits: null,
      });

      const second = await app.inject({
        method: "PUT",
        url: `/proposals/${created.id}/budget`,
        payload: { maintenance_cost: 50, expected_benefits: "fewer potholes" },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().budget).toMatchObject({
        cost: 1000,
        funding_source: "general fund",
        maintenance_cost: 50,
        expected_benefits: "fewer potholes",
      });
    });
  });

  describe("POST /proposals/:id/scope-assignment", () => {
    it.each([
      [1000, 50],
      [1001, 51],
      [19, 1],
    ])("computes the ceil(population * 0.05) threshold for population %i", async (population, expected) => {
      app = build();
      const created = (await createProposal(app)).json();
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-assignment`,
        payload: { scope_jurisdiction_id: "jurisdiction-1", population },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().support_threshold).toBe(expected);
      expect(res.json().scope_jurisdiction_id).toBe("jurisdiction-1");
    });
  });

  describe("POST /proposals/:id/support", () => {
    it("increments support_count per distinct citizen", async () => {
      app = build();
      const created = (await createProposal(app)).json();

      const first = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/support`,
        payload: { citizen_id: "citizen-a" },
      });
      expect(first.statusCode).toBe(201);
      expect(first.json().support_count).toBe(1);

      const second = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/support`,
        payload: { citizen_id: "citizen-b" },
      });
      expect(second.json().support_count).toBe(2);
    });

    it("rejects duplicate support from the same citizen", async () => {
      app = build();
      const created = (await createProposal(app)).json();
      await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/support`,
        payload: { citizen_id: "citizen-a" },
      });
      const dup = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/support`,
        payload: { citizen_id: "citizen-a" },
      });
      expect(dup.statusCode).toBe(409);
      const read = await app.inject({
        method: "GET",
        url: `/proposals/${created.id}`,
      });
      expect(read.json().support_count).toBe(1);
    });
  });

  describe("scope challenges", () => {
    it("filing a challenge sets scope_challenge_pending and resolving clears it", async () => {
      app = build();
      const created = (await createProposal(app)).json();

      const filed = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges`,
        payload: { citizen_id: "citizen-a", reason: "wrong jurisdiction" },
      });
      expect(filed.statusCode).toBe(201);
      expect(filed.json().scope_challenge_pending).toBe(true);
      const challengeId = filed.json().scope_challenges[0].id;

      const resolved = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges/${challengeId}/resolve`,
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().scope_challenge_pending).toBe(false);
      expect(resolved.json().scope_challenges[0].resolved).toBe(true);
    });

    it("404s resolving an unknown challenge", async () => {
      app = build();
      const created = (await createProposal(app)).json();
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges/does-not-exist/resolve`,
      });
      expect(res.statusCode).toBe(404);
    });

    it("filing a challenge requests an independent review body (DP-020)", async () => {
      const requestReviewBody = vi.fn();
      app = build({ scopeEscalationRequester: { requestReviewBody } });
      const created = (await createProposal(app)).json();

      const filed = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges`,
        payload: { citizen_id: "citizen-a", reason: "wrong jurisdiction" },
      });
      const challengeId = filed.json().scope_challenges[0].id;

      expect(requestReviewBody).toHaveBeenCalledTimes(1);
      expect(requestReviewBody).toHaveBeenCalledWith(created.id, challengeId);
    });
  });

  describe("POST /proposals/:id/advance", () => {
    it("draft -> gathering_support is always allowed", async () => {
      app = build();
      const created = (await createProposal(app)).json();
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/advance`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("gathering_support");
    });

    it("gathering_support -> development is blocked below the support threshold", async () => {
      app = build();
      const proposal = await advanceTo(app, "gathering_support");
      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/scope-assignment`,
        payload: { scope_jurisdiction_id: "jurisdiction-1", population: 1000 },
      });
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(res.statusCode).toBe(409);
      const read = await app.inject({
        method: "GET",
        url: `/proposals/${proposal.id}`,
      });
      expect(read.json().status).toBe("gathering_support");
    });

    it("gathering_support -> development succeeds once the threshold is met", async () => {
      app = build();
      const proposal = await advanceTo(app, "gathering_support");
      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/scope-assignment`,
        payload: { scope_jurisdiction_id: "jurisdiction-1", population: 20 },
      });
      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/support`,
        payload: { citizen_id: "citizen-a" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("development");
    });

    it("development -> voting is blocked with the list of missing budget fields", async () => {
      app = build();
      // Reaching development requires scope-assignment to have run already
      // (it sets support_threshold, gating gathering_support -> development),
      // so scope is necessarily set here -- only budget fields are missing.
      const proposal = await advanceTo(app, "development");
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("cost");
      expect(res.json().error).toContain("funding_source");
      expect(res.json().error).toContain("maintenance_cost");
      expect(res.json().error).toContain("expected_benefits");
      expect(res.json().error).not.toContain("scope_jurisdiction_id");
    });

    it("development -> voting is blocked in isolation when scope is missing", async () => {
      const store = createStore();
      app = build({ store });
      const proposal = await advanceTo(app, "development", {
        completeBudget: true,
      });
      // Bypass the API to isolate this gate: normal flow can't reach
      // development without scope already set (see test above).
      const record = store.get(proposal.id);
      if (!record) throw new Error("proposal missing from store");
      record.scopeJurisdictionId = null;

      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("scope_jurisdiction_id");
      expect(res.json().error).not.toContain("cost");
    });

    it("development -> voting is blocked while a scope challenge is pending", async () => {
      app = build();
      const proposal = await advanceTo(app, "development", {
        completeBudget: true,
      });
      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/scope-challenges`,
        payload: { citizen_id: "citizen-a", reason: "dispute" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(res.statusCode).toBe(409);
      const read = await app.inject({
        method: "GET",
        url: `/proposals/${proposal.id}`,
      });
      expect(read.json().status).toBe("development");
    });

    it("development -> voting is blocked when the constitutional reviewer blocks it", async () => {
      const constitutionalReviewer = { review: async () => ({ blocked: true }) };
      app = build({ constitutionalReviewer });
      const proposal = await advanceTo(app, "development", {
        completeBudget: true,
        assignScope: true,
      });
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(res.statusCode).toBe(409);
      const read = await app.inject({
        method: "GET",
        url: `/proposals/${proposal.id}`,
      });
      expect(read.json().status).toBe("development");
    });

    it("development -> voting succeeds when every gate clears, calling VoteSessionRequester exactly once", async () => {
      const requestSession = vi.fn();
      app = build({
        constitutionalReviewer: defaultConstitutionalReviewer,
        voteSessionRequester: { requestSession },
      });
      const proposal = await advanceTo(app, "development", {
        completeBudget: true,
        assignScope: true,
      });
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("voting");
      expect(requestSession).toHaveBeenCalledTimes(1);
      expect(requestSession).toHaveBeenCalledWith(proposal.id);
    });

    it("VoteSessionRequester is not called on a blocked development -> voting attempt", async () => {
      const requestSession = vi.fn();
      app = build({
        constitutionalReviewer: { review: async () => ({ blocked: true }) },
        voteSessionRequester: { requestSession },
      });
      const proposal = await advanceTo(app, "development", {
        completeBudget: true,
        assignScope: true,
      });
      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(requestSession).not.toHaveBeenCalled();
    });

    it.each(["voting", "approved", "rejected", "archived"] as const)(
      "rejects advance from terminal-ish status %s",
      async (status) => {
        app = build();
        const proposal = await advanceTo(app, status);
        const res = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/advance`,
        });
        expect(res.statusCode).toBe(409);
      },
    );
  });

  describe("POST /proposals/:id/resolve", () => {
    it.each(["approved", "rejected"] as const)(
      "resolves to %s from voting",
      async (outcome) => {
        app = build();
        const proposal = await advanceTo(app, "voting");
        const res = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/resolve`,
          payload: { outcome },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe(outcome);
      },
    );

    it.each(["draft", "gathering_support", "development"] as const)(
      "rejects resolving to approved from %s",
      async (status) => {
        app = build();
        const proposal = await advanceTo(app, status);
        const res = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/resolve`,
          payload: { outcome: "approved" },
        });
        expect(res.statusCode).toBe(409);
      },
    );

    it.each(["draft", "gathering_support", "development", "voting"] as const)(
      "allows archiving from non-terminal status %s",
      async (status) => {
        app = build();
        const proposal = await advanceTo(app, status);
        const res = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/resolve`,
          payload: { outcome: "archived" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe("archived");
      },
    );

    it.each(["approved", "rejected", "archived"] as const)(
      "rejects archiving from terminal status %s",
      async (status) => {
        app = build();
        const proposal = await advanceTo(app, status);
        const res = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/resolve`,
          payload: { outcome: "archived" },
        });
        expect(res.statusCode).toBe(409);
      },
    );
  });

  describe("deadlock resolution framework (FR-034)", () => {
    const STAGES = [
      "constraint_analysis",
      "alternative_generation",
      "resource_partitioning",
      "compensation_assessment",
      "citizen_assembly_review",
      "escalation_review",
      "constitutional_review",
      "final_decision",
    ] as const;

    async function enterDeadlock(app: FastifyInstance, id: string) {
      return app.inject({
        method: "POST",
        url: `/proposals/${id}/deadlock/enter`,
        payload: { reason: "stuck on funding disagreement" },
      });
    }

    it.each(["draft", "gathering_support", "approved"] as const)(
      "rejects entering deadlock from ineligible status %s",
      async (status) => {
        app = build();
        const proposal = await advanceTo(app, status);
        const res = await enterDeadlock(app, proposal.id);
        expect(res.statusCode).toBe(409);
      },
    );

    it.each(["development", "voting"] as const)(
      "enters deadlock from status %s, setting stage to constraint_analysis",
      async (status) => {
        app = build();
        const proposal = await advanceTo(app, status);
        const res = await enterDeadlock(app, proposal.id);
        expect(res.statusCode).toBe(200);
        expect(res.json().deadlock).toMatchObject({
          active: true,
          stage: "constraint_analysis",
        });
        expect(res.json().deadlock.entered_at).toBeTypeOf("string");
        expect(res.json().deadlock.history).toHaveLength(1);
      },
    );

    it("rejects entering deadlock twice", async () => {
      app = build();
      const proposal = await advanceTo(app, "development");
      const first = await enterDeadlock(app, proposal.id);
      expect(first.statusCode).toBe(200);
      const second = await enterDeadlock(app, proposal.id);
      expect(second.statusCode).toBe(409);
    });

    it("rejects advancing the deadlock track before it has been entered", async () => {
      app = build();
      const proposal = await advanceTo(app, "development");
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/deadlock/advance`,
        payload: { reviewer_id: "reviewer-1", notes: "n/a" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("rejects advancing when the reviewer is not assigned, and succeeds when assigned", async () => {
      const isAssignedReviewer = vi.fn().mockReturnValue(false);
      app = build({ assignmentChecker: { isAssignedReviewer } });
      const proposal = await advanceTo(app, "development");
      await enterDeadlock(app, proposal.id);

      const rejected = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/deadlock/advance`,
        payload: { reviewer_id: "reviewer-1", notes: "reviewing" },
      });
      expect(rejected.statusCode).toBe(403);
      expect(isAssignedReviewer).toHaveBeenCalledWith(
        "reviewer-1",
        proposal.id,
      );

      isAssignedReviewer.mockReturnValue(true);
      const allowed = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/deadlock/advance`,
        payload: { reviewer_id: "reviewer-1", notes: "reviewing" },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().deadlock.stage).toBe("alternative_generation");
    });

    it("blocks the normal /advance endpoint with 409 while deadlock is active", async () => {
      app = build();
      const proposal = await advanceTo(app, "development");
      await enterDeadlock(app, proposal.id);
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(res.statusCode).toBe(409);
    });

    it("blocks the normal /resolve endpoint with 409 while deadlock is active", async () => {
      app = build();
      const proposal = await advanceTo(app, "voting");
      await enterDeadlock(app, proposal.id);
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/resolve`,
        payload: { outcome: "approved" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("rejects reaching final_decision without an outcome", async () => {
      app = build();
      const proposal = await advanceTo(app, "development");
      await enterDeadlock(app, proposal.id);
      let last;
      for (let i = 1; i < STAGES.length; i++) {
        last = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/deadlock/advance`,
          payload: { reviewer_id: "reviewer-1", notes: `advancing to ${STAGES[i]}` },
        });
        expect(last.json().deadlock.stage).toBe(STAGES[i]);
      }
      expect(last!.json().deadlock.stage).toBe("final_decision");

      const noOutcome = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/deadlock/advance`,
        payload: { reviewer_id: "reviewer-1", notes: "ready to decide" },
      });
      expect(noOutcome.statusCode).toBe(400);
    });

    it("resolves the proposal when an outcome is provided at final_decision, bypassing normal gates", async () => {
      app = build();
      // Enter deadlock from development -- normal resolveProposal only
      // allows "approved" from voting, but the deadlock escape hatch must
      // be able to conclude the case regardless of the status it was
      // entered from.
      const proposal = await advanceTo(app, "development");
      await enterDeadlock(app, proposal.id);
      for (let i = 1; i < STAGES.length; i++) {
        await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/deadlock/advance`,
          payload: { reviewer_id: "reviewer-1", notes: "advancing" },
        });
      }

      const resolved = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/deadlock/advance`,
        payload: {
          reviewer_id: "reviewer-1",
          notes: "final decision reached",
          outcome: "approved",
        },
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().status).toBe("approved");
      expect(resolved.json().deadlock.active).toBe(false);
      expect(resolved.json().deadlock.resolved_at).toBeTypeOf("string");
      expect(resolved.json().deadlock.history).toHaveLength(STAGES.length);

      const read = await app.inject({
        method: "GET",
        url: `/proposals/${proposal.id}`,
      });
      expect(read.json().status).toBe("approved");
    });

    it("GET /proposals/:id/deadlock reads stage, active flag, and full history", async () => {
      app = build();
      const proposal = await advanceTo(app, "development");
      await enterDeadlock(app, proposal.id);
      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/deadlock/advance`,
        payload: { reviewer_id: "reviewer-1", notes: "moving on" },
      });

      const res = await app.inject({
        method: "GET",
        url: `/proposals/${proposal.id}/deadlock`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        active: true,
        stage: "alternative_generation",
      });
      expect(res.json().history).toHaveLength(2);
      expect(res.json().history[1]).toMatchObject({
        stage: "alternative_generation",
        reviewer_id: "reviewer-1",
        notes: "moving on",
      });
    });

    it("404s reading the deadlock state of an unknown proposal", async () => {
      app = build();
      const res = await app.inject({
        method: "GET",
        url: "/proposals/does-not-exist/deadlock",
      });
      expect(res.statusCode).toBe(404);
    });

    it("runs the full 8-stage deadlock happy path end-to-end", async () => {
      app = build();
      const proposal = await advanceTo(app, "voting");

      const entered = await enterDeadlock(app, proposal.id);
      expect(entered.json().deadlock.stage).toBe("constraint_analysis");

      let last;
      for (let i = 1; i < STAGES.length; i++) {
        last = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/deadlock/advance`,
          payload: {
            reviewer_id: "reviewer-1",
            notes: `entering ${STAGES[i]}`,
          },
        });
        expect(last.statusCode).toBe(200);
        expect(last.json().deadlock.stage).toBe(STAGES[i]);
        expect(last.json().deadlock.active).toBe(true);
      }

      const final = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/deadlock/advance`,
        payload: {
          reviewer_id: "reviewer-1",
          notes: "final decision",
          outcome: "rejected",
        },
      });
      expect(final.statusCode).toBe(200);
      expect(final.json().status).toBe("rejected");
      expect(final.json().deadlock.active).toBe(false);

      const history = final.json().deadlock.history;
      expect(history).toHaveLength(STAGES.length);
      expect(history.map((h: { stage: string }) => h.stage)).toEqual([
        ...STAGES,
      ]);
    });
  });

  it("runs the full happy-path lifecycle for one proposal", async () => {
    const requestSession = vi.fn();
    app = build({
      constitutionalReviewer: defaultConstitutionalReviewer,
      voteSessionRequester: { requestSession },
      auditEmitter: defaultAuditEmitter,
    });

    const created = (await createProposal(app)).json();
    expect(created.status).toBe("draft");

    await app.inject({
      method: "POST",
      url: `/proposals/${created.id}/constraints`,
      payload: { author_id: "citizen-1", text: "must be paved by spring" },
    });

    const toGathering = await app.inject({
      method: "POST",
      url: `/proposals/${created.id}/advance`,
    });
    expect(toGathering.json().status).toBe("gathering_support");

    await app.inject({
      method: "POST",
      url: `/proposals/${created.id}/scope-assignment`,
      payload: { scope_jurisdiction_id: "jurisdiction-1", population: 20 },
    });
    await app.inject({
      method: "POST",
      url: `/proposals/${created.id}/support`,
      payload: { citizen_id: "citizen-a" },
    });

    const toDevelopment = await app.inject({
      method: "POST",
      url: `/proposals/${created.id}/advance`,
    });
    expect(toDevelopment.json().status).toBe("development");

    await app.inject({
      method: "PUT",
      url: `/proposals/${created.id}/budget`,
      payload: {
        cost: 1000,
        funding_source: "general fund",
        maintenance_cost: 50,
        expected_benefits: "fewer potholes",
      },
    });

    const toVoting = await app.inject({
      method: "POST",
      url: `/proposals/${created.id}/advance`,
    });
    expect(toVoting.json().status).toBe("voting");
    expect(requestSession).toHaveBeenCalledTimes(1);

    const resolved = await app.inject({
      method: "POST",
      url: `/proposals/${created.id}/resolve`,
      payload: { outcome: "approved" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe("approved");
  });
});

async function advanceTo(
  app: FastifyInstance,
  status:
    | "draft"
    | "gathering_support"
    | "development"
    | "voting"
    | "approved"
    | "rejected"
    | "archived",
  options: { completeBudget?: boolean; assignScope?: boolean } = {},
) {
  const created = (await createProposal(app)).json();
  if (status === "draft") return created;

  await app.inject({
    method: "POST",
    url: `/proposals/${created.id}/scope-assignment`,
    payload: { scope_jurisdiction_id: "jurisdiction-1", population: 20 },
  });
  await app.inject({
    method: "POST",
    url: `/proposals/${created.id}/support`,
    payload: { citizen_id: "citizen-a" },
  });
  await app.inject({
    method: "POST",
    url: `/proposals/${created.id}/advance`,
  });
  if (status === "gathering_support") {
    return (
      await app.inject({ method: "GET", url: `/proposals/${created.id}` })
    ).json();
  }

  if (options.completeBudget) {
    await app.inject({
      method: "PUT",
      url: `/proposals/${created.id}/budget`,
      payload: {
        cost: 1000,
        funding_source: "general fund",
        maintenance_cost: 50,
        expected_benefits: "fewer potholes",
      },
    });
  }
  await app.inject({
    method: "POST",
    url: `/proposals/${created.id}/advance`,
  });
  if (status === "development") {
    return (
      await app.inject({ method: "GET", url: `/proposals/${created.id}` })
    ).json();
  }

  if (!options.completeBudget) {
    await app.inject({
      method: "PUT",
      url: `/proposals/${created.id}/budget`,
      payload: {
        cost: 1000,
        funding_source: "general fund",
        maintenance_cost: 50,
        expected_benefits: "fewer potholes",
      },
    });
  }
  await app.inject({
    method: "POST",
    url: `/proposals/${created.id}/advance`,
  });
  if (status === "voting") {
    return (
      await app.inject({ method: "GET", url: `/proposals/${created.id}` })
    ).json();
  }

  await app.inject({
    method: "POST",
    url: `/proposals/${created.id}/resolve`,
    payload: { outcome: status },
  });
  return (
    await app.inject({ method: "GET", url: `/proposals/${created.id}` })
  ).json();
}
