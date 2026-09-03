// ARCH-012: Problem -> proposal lifecycle. Integration/e2e scenarios
// spanning problem-service and proposal-service. Every service here is a
// real process (see ./harness.ts) reached over real HTTP. Scenario ids
// (HPn/ECn) match .spec/technical/architecture/arch-012.md verbatim.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnTsService, type SpawnedService } from "./harness.js";

async function asJson(res: Response) {
  return JSON.parse(await res.text());
}

describe("ARCH-012 problem -> proposal lifecycle (full fleet)", () => {
  const PROBLEM_PORT = 48612;
  const PROPOSAL_PORT = 48614;
  const PROBLEM_URL = `http://127.0.0.1:${PROBLEM_PORT}`;
  const PROPOSAL_URL = `http://127.0.0.1:${PROPOSAL_PORT}`;

  let problem: SpawnedService;
  let proposal: SpawnedService;

  beforeAll(async () => {
    problem = await spawnTsService("problem-service", PROBLEM_PORT);
    proposal = await spawnTsService("proposal-service", PROPOSAL_PORT, {
      PROBLEM_SERVICE_URL: PROBLEM_URL,
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([problem?.stop(), proposal?.stop()]);
  });

  // --- problem-service client ---
  async function submitProblem() {
    const uid = randomUUID();
    const res = await fetch(`${PROBLEM_URL}/problems`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizen_id: `citizen-${uid}`,
        title: `Problem ${uid}`,
        description: "A problem for ARCH-012 e2e coverage",
        affected_area: "Main St corridor",
        candidate_scope: "city",
      }),
    });
    return asJson(res);
  }
  async function endorseProblem(problemId: string, citizenId: string) {
    const res = await fetch(`${PROBLEM_URL}/problems/${problemId}/support`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizen_id: citizenId }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function getProblem(problemId: string) {
    const res = await fetch(`${PROBLEM_URL}/problems/${problemId}`);
    return { status: res.status, body: await asJson(res) };
  }

  // --- proposal-service client ---
  async function createProposal(problemId: string) {
    const uid = randomUUID();
    const res = await fetch(`${PROPOSAL_URL}/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        problem_id: problemId,
        title: `Proposal ${uid}`,
        description: "A proposal for ARCH-012 e2e coverage",
        author_id: `author-${uid}`,
      }),
    });
    return asJson(res);
  }
  async function advanceProposal(id: string) {
    const res = await fetch(`${PROPOSAL_URL}/proposals/${id}/advance`, { method: "POST" });
    return { status: res.status, body: await asJson(res) };
  }
  async function assignScope(id: string, population: number) {
    const res = await fetch(`${PROPOSAL_URL}/proposals/${id}/scope-assignment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope_jurisdiction_id: "jurisdiction-1", population }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function supportProposal(id: string, citizenId: string) {
    return fetch(`${PROPOSAL_URL}/proposals/${id}/support`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizen_id: citizenId }),
    });
  }
  async function resolveProposal(id: string, outcome: string) {
    const res = await fetch(`${PROPOSAL_URL}/proposals/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome }),
    });
    return { status: res.status, body: await asJson(res) };
  }

  async function waitFor<T>(check: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T;
    do {
      last = await check();
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return last!;
  }

  it("HP-1: problem submitted, publicly endorsed, and a proposal created against it", async () => {
    const created = await submitProblem();
    expect(created.status).toBe("open");

    const endorsers = [randomUUID(), randomUUID(), randomUUID()];
    let lastCount = 0;
    for (const citizenId of endorsers) {
      const res = await endorseProblem(created.id, citizenId);
      expect(res.status).toBe(200);
      lastCount = res.body.support_count;
    }
    expect(lastCount).toBe(3);

    const read = await getProblem(created.id);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(created.id);

    const proposalRecord = await createProposal(created.id);
    expect(proposalRecord.status).toBe("draft");
    expect(proposalRecord.problem_id).toBe(created.id);
    expect(proposalRecord.support_count).toBe(0);
    expect(proposalRecord.support_threshold).toBeNull();
  });

  // ARCH-012 EC-33: the real cross-service confirmation of the seam this
  // doc's implementation pass built -- proposal-service's ProblemStatusNotifier
  // actually reaching a live problem-service.
  it("IT-012-EC-33: a proposal reaching development transitions its problem to proposing", async () => {
    const created = await submitProblem();
    const proposalRecord = await createProposal(created.id);
    await advanceProposal(proposalRecord.id); // draft -> gathering_support
    await assignScope(proposalRecord.id, 20); // threshold = 1
    await supportProposal(proposalRecord.id, randomUUID());
    const advanced = await advanceProposal(proposalRecord.id); // -> development
    expect(advanced.status).toBe(200);
    expect(advanced.body.status).toBe("development");

    const updated = await waitFor(
      () => getProblem(created.id),
      (r) => r.body.status !== "open",
    );
    expect(updated.body.status).toBe("proposing");
  });

  it("IT-012-EC-33: a proposal's approval transitions its problem to closed", async () => {
    const created = await submitProblem();
    const proposalRecord = await createProposal(created.id);
    await advanceProposal(proposalRecord.id); // -> gathering_support
    await assignScope(proposalRecord.id, 20);
    await supportProposal(proposalRecord.id, randomUUID());
    await advanceProposal(proposalRecord.id); // -> development
    // Wait for the (fire-and-forget) "proposing" notification to land before
    // continuing, so the later "closed" notification's proposing->closed
    // transition is guaranteed to be legal on problem-service's side.
    await waitFor(
      () => getProblem(created.id),
      (r) => r.body.status !== "open",
    );
    await fetch(`${PROPOSAL_URL}/proposals/${proposalRecord.id}/budget`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cost: 1000,
        funding_source: "general fund",
        maintenance_cost: 50,
        expected_benefits: "fewer potholes",
      }),
    });
    await advanceProposal(proposalRecord.id); // -> voting
    const resolved = await resolveProposal(proposalRecord.id, "approved");
    expect(resolved.status).toBe(200);

    const updated = await waitFor(
      () => getProblem(created.id),
      (r) => r.body.status === "closed",
    );
    expect(updated.body.status).toBe("closed");
  });
});
