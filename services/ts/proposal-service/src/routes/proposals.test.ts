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

    // ARCH-012 EC-34: proposal-service performs no existence check against
    // problem-service -- any string is accepted as problem_id, documented
    // current behavior (mirrors EC-32's gap running the other direction).
    it("IT-012-EC-34: accepts a problem_id that does not exist anywhere, with no existence check", async () => {
      app = build();
      const res = await createProposal(app, { problem_id: "00000000-0000-0000-0000-000000000000" });
      expect(res.statusCode).toBe(201);
      expect(res.json().problem_id).toBe("00000000-0000-0000-0000-000000000000");
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

    // ARCH-012 EC-4.
    it.each(["cost", "maintenance_cost"] as const)(
      "IT-012-EC-4: rejects a negative %s with 400",
      async (field) => {
        app = build();
        const created = (await createProposal(app)).json();
        const res = await app.inject({
          method: "PUT",
          url: `/proposals/${created.id}/budget`,
          payload: { [field]: -1 },
        });
        expect(res.statusCode).toBe(400);
      },
    );
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

    // ARCH-011 EC-20: a zero-population jurisdiction never actually gates.
    it("IT-011-EC-20: population 0 yields support_threshold 0", async () => {
      app = build();
      const created = (await createProposal(app)).json();
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-assignment`,
        payload: { scope_jurisdiction_id: "jurisdiction-1", population: 0 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().support_threshold).toBe(0);
    });

    // ARCH-012 EC-24: the full consequence of a zero-population threshold --
    // gathering_support -> development advances immediately with zero supporters.
    it("IT-012-EC-24: gathering_support -> development advances immediately when population is 0", async () => {
      app = build();
      const proposal = await advanceTo(app, "gathering_support");
      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/scope-assignment`,
        payload: { scope_jurisdiction_id: "jurisdiction-1", population: 0 },
      });
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("development");
    });

    it.each([
      [-1, "negative population"],
      [undefined, "missing population"],
    ])("IT-011-EC-4: rejects scope-assignment with %s (400)", async (population, _label) => {
      app = build();
      const created = (await createProposal(app)).json();
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-assignment`,
        payload:
          population === undefined
            ? { scope_jurisdiction_id: "jurisdiction-1" }
            : { scope_jurisdiction_id: "jurisdiction-1", population },
      });
      expect(res.statusCode).toBe(400);
    });

    // ARCH-011 EC-5: scope_jurisdiction_id is now validated against
    // jurisdiction-service via the injected JurisdictionClient.
    it("IT-011-EC-5: rejects a scope_jurisdiction_id the JurisdictionClient reports as nonexistent", async () => {
      app = build({ jurisdictionClient: { exists: async () => false } });
      const created = (await createProposal(app)).json();
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-assignment`,
        payload: { scope_jurisdiction_id: "ghost-jurisdiction", population: 100 },
      });
      expect(res.statusCode).toBe(400);
      const read = await app.inject({ method: "GET", url: `/proposals/${created.id}` });
      expect(read.json().scope_jurisdiction_id).toBeNull();
    });

    // ARCH-011 EC-7: assignScope isn't gated on proposal status today --
    // documented current behavior, not a fix.
    it.each(["draft", "voting", "approved", "archived"] as const)(
      "IT-011-EC-7: succeeds regardless of proposal status (status %s)",
      async (status) => {
        app = build();
        const proposal = await advanceTo(app, status);
        const res = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/scope-assignment`,
          payload: { scope_jurisdiction_id: "jurisdiction-2", population: 40 },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().scope_jurisdiction_id).toBe("jurisdiction-2");
      },
    );

    // ARCH-011 EC-23: re-assigning scope after support has already been
    // gathered recomputes the threshold with nothing re-validating prior
    // support against it -- documented current behavior.
    it("IT-011-EC-23: re-assigning scope after support is gathered does not re-validate prior support", async () => {
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
      // Now supportCount (1) == threshold (1). Re-assign scope to a much
      // larger population, raising the threshold above already-gathered support.
      const reassigned = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/scope-assignment`,
        payload: { scope_jurisdiction_id: "jurisdiction-2", population: 1000 },
      });
      expect(reassigned.json().support_threshold).toBe(50);
      expect(reassigned.json().support_count).toBe(1);

      const blocked = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(blocked.statusCode).toBe(409);
    });

    // ARCH-011 EC-28: no version/optimistic-lock field exists -- last write wins.
    it("IT-011-EC-28: two concurrent scope-assignment calls are last-write-wins with no conflict signaled", async () => {
      app = build();
      const created = (await createProposal(app)).json();
      const [a, b] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/proposals/${created.id}/scope-assignment`,
          payload: { scope_jurisdiction_id: "jurisdiction-a", population: 100 },
        }),
        app.inject({
          method: "POST",
          url: `/proposals/${created.id}/scope-assignment`,
          payload: { scope_jurisdiction_id: "jurisdiction-b", population: 200 },
        }),
      ]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);

      const read = await app.inject({ method: "GET", url: `/proposals/${created.id}` });
      expect(["jurisdiction-a", "jurisdiction-b"]).toContain(read.json().scope_jurisdiction_id);
    });

    it("IT-011-EC-37: emits an audit event for scope assignment", async () => {
      const events: string[] = [];
      app = build({ auditEmitter: { emit: (eventType) => events.push(eventType) } });
      const created = (await createProposal(app)).json();
      await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-assignment`,
        payload: { scope_jurisdiction_id: "jurisdiction-1", population: 100 },
      });
      expect(events).toContain("proposal.scope_assigned");
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

    // ARCH-012 EC-21 (blocked on: missing eligibility check) -- no
    // jurisdiction/eligibility check on citizen_id exists; this documents
    // the current, permissive behavior rather than a passing scenario.
    it("IT-012-EC-21: accepts support from any citizen_id with no scope/eligibility check", async () => {
      app = build();
      const created = (await createProposal(app)).json();
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/support`,
        payload: { citizen_id: "citizen-outside-any-jurisdiction" },
      });
      expect(res.statusCode).toBe(201);
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

    // ARCH-011 EC-8: fileScopeChallenge isn't gated on proposal status --
    // documented current behavior, not a fix.
    it.each(["draft", "voting", "approved", "archived"] as const)(
      "IT-011-EC-8: filing succeeds regardless of proposal status (status %s)",
      async (status) => {
        app = build();
        const proposal = await advanceTo(app, status);
        const res = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/scope-challenges`,
          payload: { citizen_id: "citizen-a", reason: "dispute" },
        });
        expect(res.statusCode).toBe(201);
      },
    );

    it("IT-011-EC-9: rejects resolving an already-resolved challenge with 409", async () => {
      app = build();
      const created = (await createProposal(app)).json();
      const filed = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges`,
        payload: { citizen_id: "citizen-a", reason: "wrong jurisdiction" },
      });
      const challengeId = filed.json().scope_challenges[0].id;

      const first = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges/${challengeId}/resolve`,
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges/${challengeId}/resolve`,
      });
      expect(second.statusCode).toBe(409);
    });

    // ARCH-011 EC-11: scope_challenge_pending is a single flag over all
    // challenges -- resolving just the first clears it for the proposal as
    // a whole even though the second challenge's own `resolved` stays false.
    it("IT-011-EC-11: resolving one of two open challenges clears scope_challenge_pending for the whole proposal", async () => {
      app = build();
      const created = (await createProposal(app)).json();
      const firstFiled = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges`,
        payload: { citizen_id: "citizen-a", reason: "first dispute" },
      });
      const secondFiled = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges`,
        payload: { citizen_id: "citizen-b", reason: "second dispute" },
      });
      expect(firstFiled.statusCode).toBe(201);
      expect(secondFiled.statusCode).toBe(201);
      const firstId = firstFiled.json().scope_challenges[0].id;

      const resolved = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges/${firstId}/resolve`,
      });
      expect(resolved.json().scope_challenge_pending).toBe(false);
      const secondChallenge = resolved
        .json()
        .scope_challenges.find((c: { id: string }) => c.id !== firstId);
      expect(secondChallenge.resolved).toBe(false);
    });

    // ARCH-011 EC-19: no check that citizen_id refers to a real/active citizen.
    it("IT-011-EC-19: accepts any citizen_id string with no validity check", async () => {
      app = build();
      const created = (await createProposal(app)).json();
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges`,
        payload: { citizen_id: "not-a-real-citizen-id", reason: "dispute" },
      });
      expect(res.statusCode).toBe(201);
    });

    // ARCH-011 EC-27: two concurrent resolve calls racing on the same
    // challenge -- exactly one succeeds, the other observes it already resolved.
    it("IT-011-EC-27: two concurrent resolve calls on the same challenge: one 200, one 409", async () => {
      app = build();
      const created = (await createProposal(app)).json();
      const filed = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges`,
        payload: { citizen_id: "citizen-a", reason: "dispute" },
      });
      const challengeId = filed.json().scope_challenges[0].id;

      const [a, b] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/proposals/${created.id}/scope-challenges/${challengeId}/resolve`,
        }),
        app.inject({
          method: "POST",
          url: `/proposals/${created.id}/scope-challenges/${challengeId}/resolve`,
        }),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 409]);
    });

    it("IT-011-EC-37: emits audit events for filing and resolving a scope challenge", async () => {
      const events: string[] = [];
      app = build({ auditEmitter: { emit: (eventType) => events.push(eventType) } });
      const created = (await createProposal(app)).json();
      const filed = await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges`,
        payload: { citizen_id: "citizen-a", reason: "dispute" },
      });
      const challengeId = filed.json().scope_challenges[0].id;
      await app.inject({
        method: "POST",
        url: `/proposals/${created.id}/scope-challenges/${challengeId}/resolve`,
      });

      expect(events).toContain("proposal.scope_challenge_filed");
      expect(events).toContain("proposal.scope_challenge_resolved");
    });

    // ARCH-011 HP-6: full challenge-blocks-then-unblocks-voting journey.
    it("HP-6: a scope challenge blocks development -> voting until resolved", async () => {
      app = build();
      const proposal = await advanceTo(app, "development", { completeBudget: true });

      const filed = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/scope-challenges`,
        payload: { citizen_id: "citizen-a", reason: "wrong jurisdiction" },
      });
      expect(filed.statusCode).toBe(201);
      expect(filed.json().scope_challenge_pending).toBe(true);
      const challengeId = filed.json().scope_challenges[0].id;

      const blocked = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(blocked.statusCode).toBe(409);

      const resolved = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/scope-challenges/${challengeId}/resolve`,
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().scope_challenge_pending).toBe(false);

      const advanced = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(advanced.statusCode).toBe(200);
      expect(advanced.json().status).toBe("voting");
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

    // ARCH-011 EC-22: exactly-at-threshold advances; one-under is rejected.
    it("IT-011-EC-22: support count exactly at threshold advances; one under is rejected", async () => {
      app = build();
      const proposal = await advanceTo(app, "gathering_support");
      // population 40 -> threshold ceil(40*0.05) = 2
      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/scope-assignment`,
        payload: { scope_jurisdiction_id: "jurisdiction-1", population: 40 },
      });
      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/support`,
        payload: { citizen_id: "citizen-a" },
      });
      const oneUnder = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(oneUnder.statusCode).toBe(409);

      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/support`,
        payload: { citizen_id: "citizen-b" },
      });
      const atThreshold = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(atThreshold.statusCode).toBe(200);
      expect(atThreshold.json().status).toBe("development");
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

    // ARCH-012 EC-26: each budget field named singly, not just all-at-once.
    it.each([
      ["cost", { funding_source: "general fund", maintenance_cost: 50, expected_benefits: "fewer potholes" }],
      ["funding_source", { cost: 1000, maintenance_cost: 50, expected_benefits: "fewer potholes" }],
      ["maintenance_cost", { cost: 1000, funding_source: "general fund", expected_benefits: "fewer potholes" }],
      ["expected_benefits", { cost: 1000, funding_source: "general fund", maintenance_cost: 50 }],
    ] as const)("IT-012-EC-26: names only %s when it alone is missing", async (missingField, partialBudget) => {
      app = build();
      const proposal = await advanceTo(app, "development");
      await app.inject({
        method: "PUT",
        url: `/proposals/${proposal.id}/budget`,
        payload: partialBudget,
      });
      const res = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/advance`,
      });
      expect(res.statusCode).toBe(409);
      const namedFields = (res.json().error as string)
        .replace("missing required fields: ", "")
        .split(", ");
      expect(namedFields).toEqual([missingField]);
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

    // ARCH-012 EC-10: the same non-voting-status gate applies to "rejected", not just "approved".
    it.each(["draft", "gathering_support", "development"] as const)(
      "IT-012-EC-10: rejects resolving to rejected from %s",
      async (status) => {
        app = build();
        const proposal = await advanceTo(app, status);
        const res = await app.inject({
          method: "POST",
          url: `/proposals/${proposal.id}/resolve`,
          payload: { outcome: "rejected" },
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

    it.each(["draft", "gathering_support", "approved", "rejected", "archived"] as const)(
      "IT-012-EC-12: rejects entering deadlock from ineligible status %s",
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

    // ARCH-014 EC-7: reviewer_id/notes are schema-required on every
    // deadlock/advance call, checked before any domain logic runs.
    it("ARCH-014 EC-7: rejects deadlock/advance missing reviewer_id or notes with 400", async () => {
      app = build();
      const proposal = await advanceTo(app, "development");
      await enterDeadlock(app, proposal.id);

      const missingReviewer = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/deadlock/advance`,
        payload: { notes: "n/a" },
      });
      expect(missingReviewer.statusCode).toBe(400);

      const missingNotes = await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/deadlock/advance`,
        payload: { reviewer_id: "reviewer-1" },
      });
      expect(missingNotes.statusCode).toBe(400);
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

      // ARCH-012 EC-39: the dedicated deadlock endpoint still returns the
      // full history after resolution, not cleared.
      const deadlockRead = await app.inject({
        method: "GET",
        url: `/proposals/${proposal.id}/deadlock`,
      });
      expect(deadlockRead.json().active).toBe(false);
      expect(deadlockRead.json().resolved_at).toBeTypeOf("string");
      expect(deadlockRead.json().history).toHaveLength(STAGES.length);
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

  // ARCH-012 HP-2: a single proposal's fully-eligible, uncontested lifecycle
  // from draft to approved.
  it("HP-2: runs the full happy-path lifecycle for one proposal", async () => {
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
    // End state per ARCH-012 HP-2: budget complete, scope assigned, one
    // agreed-pending constraint, support_count === support_threshold.
    expect(resolved.json().budget).toMatchObject({
      cost: 1000,
      funding_source: "general fund",
      maintenance_cost: 50,
      expected_benefits: "fewer potholes",
    });
    expect(resolved.json().scope_jurisdiction_id).toBe("jurisdiction-1");
    expect(resolved.json().constraints).toHaveLength(1);
    expect(resolved.json().constraints[0].agreed).toBe(false);
    expect(resolved.json().support_count).toBe(resolved.json().support_threshold);
  });

  // ARCH-012 EC-37: every proposal status transition, including both
  // deadlock-track entry and exit, invokes AuditEmitter.emit exactly once.
  it("IT-012-EC-37: emits proposal.status_changed exactly once per transition across the full lifecycle", async () => {
    const events: Array<{ eventType: string; payload: unknown }> = [];
    app = build({
      auditEmitter: { emit: (eventType, payload) => events.push({ eventType, payload }) },
    });

    const created = (await createProposal(app)).json();
    await app.inject({ method: "POST", url: `/proposals/${created.id}/advance` }); // -> gathering_support
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
    await app.inject({ method: "POST", url: `/proposals/${created.id}/advance` }); // -> development
    await app.inject({
      method: "PUT",
      url: `/proposals/${created.id}/budget`,
      payload: { cost: 1, funding_source: "f", maintenance_cost: 1, expected_benefits: "b" },
    });
    await app.inject({ method: "POST", url: `/proposals/${created.id}/advance` }); // -> voting
    await app.inject({
      method: "POST",
      url: `/proposals/${created.id}/resolve`,
      payload: { outcome: "approved" },
    }); // -> approved

    const statusChanges = events.filter((e) => e.eventType === "proposal.status_changed");
    expect(statusChanges).toHaveLength(4);
    expect(statusChanges.map((e) => e.payload)).toEqual([
      { proposalId: created.id, from: "draft", to: "gathering_support" },
      { proposalId: created.id, from: "gathering_support", to: "development" },
      { proposalId: created.id, from: "development", to: "voting" },
      { proposalId: created.id, from: "voting", to: "approved" },
    ]);
  });

  it("IT-012-EC-37: emits proposal.status_changed exactly once for both deadlock entry and its final resolution", async () => {
    const events: Array<{ eventType: string; payload: unknown }> = [];
    app = build({
      auditEmitter: { emit: (eventType, payload) => events.push({ eventType, payload }) },
    });
    const proposal = await advanceTo(app, "development");
    events.length = 0;

    await app.inject({
      method: "POST",
      url: `/proposals/${proposal.id}/deadlock/enter`,
      payload: { reason: "stuck" },
    });
    const deadlockEvents = events.filter((e) => e.eventType === "proposal.deadlock_entered");
    expect(deadlockEvents).toHaveLength(1);

    // 7 calls walk from constraint_analysis (index 0) to final_decision
    // (index 7); an 8th call at final_decision, with an outcome, concludes it.
    for (let i = 0; i < 7; i++) {
      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/deadlock/advance`,
        payload: { reviewer_id: "reviewer-1", notes: "advancing" },
      });
    }
    await app.inject({
      method: "POST",
      url: `/proposals/${proposal.id}/deadlock/advance`,
      payload: { reviewer_id: "reviewer-1", notes: "final", outcome: "rejected" },
    });

    const statusChanges = events.filter((e) => e.eventType === "proposal.status_changed");
    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0]?.payload).toEqual({
      proposalId: proposal.id,
      from: "development",
      to: "rejected",
    });
  });

  // ARCH-012 EC-33: ProblemStatusNotifier wiring -- see integrations.test.ts
  // for the seam's own wire-contract tests, and
  // e2e/arch012-problem-proposal.e2e.test.ts for the real cross-service
  // confirmation against a live problem-service.
  describe("ProblemStatusNotifier wiring", () => {
    it("IT-012-EC-33: notifies problem-service 'proposing' exactly once when a proposal reaches development", async () => {
      const notify = vi.fn();
      app = build({ problemStatusNotifier: { notify } });
      const proposal = await advanceTo(app, "development");

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(proposal.problem_id, "proposing");
    });

    it("IT-012-EC-33: notifies problem-service 'closed' when the sole proposal for a problem is approved", async () => {
      const notify = vi.fn();
      app = build({ problemStatusNotifier: { notify } });
      const proposal = await advanceTo(app, "voting");
      notify.mockClear();

      await app.inject({
        method: "POST",
        url: `/proposals/${proposal.id}/resolve`,
        payload: { outcome: "approved" },
      });

      expect(notify).toHaveBeenCalledWith(proposal.problem_id, "closed");
    });

    it("IT-012-EC-33: does not notify 'closed' while a competing proposal for the same problem is still active", async () => {
      const notify = vi.fn();
      const store = createStore();
      app = build({ store, problemStatusNotifier: { notify } });

      const problemId = "shared-problem-1";
      const proposalA = (await createProposal(app, { problem_id: problemId, title: "Option A" })).json();
      const proposalB = (await createProposal(app, { problem_id: problemId, title: "Option B" })).json();
      notify.mockClear();

      // "archived" is legal from draft (unlike "rejected", which requires
      // status voting) -- both count toward TERMINAL_STATUSES either way.
      await app.inject({
        method: "POST",
        url: `/proposals/${proposalA.id}/resolve`,
        payload: { outcome: "archived" },
      });
      expect(notify).not.toHaveBeenCalledWith(problemId, "closed");

      await app.inject({
        method: "POST",
        url: `/proposals/${proposalB.id}/resolve`,
        payload: { outcome: "archived" },
      });
      expect(notify).toHaveBeenCalledWith(problemId, "closed");
    });
  });
});

// ARCH-011 EC-18: POST /proposals/:id/scope-challenges/:challengeId/resolve
// performs no actor/role check whatsoever -- any caller can resolve any
// proposal's challenge with no verification that the caller is (or
// represents) an "independent review body" separate from the proposal's
// authors. Closing this means adding a real session/actor-identity concept
// to proposal-service (there is none today, unlike identity-service/
// auth-service's session model) plus a governance-role-service call to
// confirm review-body standing -- neither exists in any form yet.
// Documented per ARCH-009 §2 rather than tested against fabricated behavior.
it.todo(
  "IT-011-EC-18 [blocked on: no actor/session identity concept or governance-role-service review-body check exists on this endpoint] -- resolving a scope challenge requires the caller to be an independent review body",
);

// ARCH-011 EC-32: voting-service deriving eligible_citizen_ids by calling
// jurisdiction-service's eligibility endpoint belongs to ARCH-016 (the
// voting lifecycle flow doc), not here -- noted in this doc only as the
// other side of the same "nothing calls jurisdiction-service's eligibility
// endpoint yet" gap ARCH-011's Overview opens with.
it.todo(
  "IT-011-EC-32 [out of scope: owned by ARCH-016] -- voting-service should derive eligible_citizen_ids via jurisdiction-service and degrade predictably if that call fails",
);

// ARCH-011 EC-33: DP-030's "review body" routing/confirmation step for
// scope assignment and scope-challenge resolution doesn't exist as a
// service call at all -- assignScope/resolveScopeChallenge apply caller
// input directly. Unlike EC-31 (a crisp single governance-role-service
// approval check this doc's implementation pass could close), DP-030's
// routing step has no defined action_ref/approval-type shape anywhere in
// this codebase to build against.
it.todo(
  "IT-011-EC-33 [blocked on: DP-030 routing target/shape does not exist] -- scope assignment and scope-challenge resolution route through an independent review body confirmation step",
);

// ARCH-011 EC-34: DP-058's daily cron escalating scope disputes that have
// exceeded their SLA without resolution has no implementation anywhere --
// ScopeChallenge carries no SLA/deadline field, and no scheduled-job
// infrastructure exists in this codebase at all. Closing this means adding
// both a new domain field and a new kind of infrastructure this service
// doesn't have yet, not just wiring an existing seam.
it.todo(
  "IT-011-EC-34 [blocked on: DP-058 cron and an SLA/deadline field do not exist in proposal-service] -- a scope challenge unresolved past its SLA is escalated, not left indefinitely pending",
);

// ARCH-012 EC-31: DP-028's documented idempotency claim ("multiple
// concurrent DP-004 events safely collapse") can't be exercised because the
// worker behind it is a no-op seam, not real code -- see EC-32 below for
// why that worker isn't built here.
it.todo(
  "IT-012-EC-31 [blocked on: ThresholdChecker/DP-028 has no real implementation to exercise concurrency against] -- concurrent endorsement events safely collapse to one threshold check",
);

// ARCH-012 EC-32: DP-028's description ("reads the current problem_support
// count for each proposal linked to the endorsed problem; if any proposal's
// count meets or exceeds support_threshold, enqueues DP-029") specifies a
// threshold source -- the PROBLEM's endorsement count -- that conflicts
// with proposal-service's actual, heavily-tested implementation, where
// support_count is proposal-service's own independent counter driven by
// POST /proposals/:id/support and has no connection to problem-level
// endorsements at all. Building HttpThresholdChecker plus a receiving
// endpoint would mean deciding whether DP-028's endorsement-count check
// replaces, feeds into, or runs alongside that existing mechanism -- a real
// product/architecture decision with no clear enough answer in the spec to
// implement confidently, unlike EC-33 (ProblemStatusNotifier), whose
// receiving endpoint and semantics were already unambiguous. Left blocked
// rather than guessed at, per ARCH-009 §2.
it.todo(
  "IT-012-EC-32 [blocked on: HttpThresholdChecker + receiving endpoint -- DP-028's threshold source is ambiguous against the existing support_count mechanism, see comment above] -- endorsing a problem recomputes whether any linked proposal has crossed its support_threshold",
);

// ARCH-012 EC-35: DP-034's constitutional review is fully synchronous and
// in-process (defaultConstitutionalReviewer) rather than a real call to an
// audit-service constitutional-review authority that doesn't exist as a
// running service in this codebase -- a downstream-down/slow/erroring
// scenario has nothing live to exercise it against yet (createHttpConstitutionalReviewer's
// own fail-closed behavior is already covered directly in integrations.test.ts).
it.todo(
  "IT-012-EC-35 [blocked on: SRV-012/audit-service is not a running service in this codebase] -- constitutional review degrades predictably when audit-service is down, slow, or erroring",
);

// ARCH-012 EC-36: VoteSessionRequester.requestSession and both services'
// AuditEmitter.emit are fire-and-forget no-ops with no live target service
// in a real deployment sense -- voting-service doesn't exist as a running
// service at all, so no failure/degradation behavior can be observed for
// it (AuditEmitter's own real HTTP implementation is already covered
// directly in integrations.test.ts, but there is still no live
// audit-service process to degrade against here).
it.todo(
  "IT-012-EC-36 [blocked on: SRV-007/voting-service is not a running service in this codebase] -- VoteSessionRequester degrades predictably when voting-service is down, slow, or erroring",
);

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
