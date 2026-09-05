// ARCH-014: Public deliberation, preference formation & deadlock resolution.
// Integration/e2e scenarios spanning deliberation-service, ai-synthesis-service,
// and proposal-service -- the two scenarios (HP-4, HP-6) this doc's Overview
// says need a "composition step that reads deliberation-service's live
// arguments/preferences before calling ai-synthesis-service", since no such
// step exists anywhere in the codebase yet. This test plays that role, the
// way every other ARCH-009 §2 fixture-assembly precedent does. Every
// service here is a real process (see ./harness.ts) reached over real HTTP.
// Scenario ids (HPn/ECn) match .spec/technical/architecture/arch-014.md
// verbatim. Most of this doc's other scenarios (HP-1/HP-2/HP-3/HP-5 and
// most ECs) are single-service and already proven by deliberation-service's,
// ai-synthesis-service's, and proposal-service's own unit suites -- see
// arch-014.md §5 for the full traceability.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnTsService, type SpawnedService } from "./harness.js";

async function asJson(res: Response) {
  return JSON.parse(await res.text());
}

describe("ARCH-014 deliberation + AI synthesis (full fleet)", () => {
  const DELIBERATION_PORT = 48141;
  const AI_SYNTHESIS_PORT = 48142;
  const PROPOSAL_PORT = 48144;
  const DELIBERATION_URL = `http://127.0.0.1:${DELIBERATION_PORT}`;
  const AI_SYNTHESIS_URL = `http://127.0.0.1:${AI_SYNTHESIS_PORT}`;
  const PROPOSAL_URL = `http://127.0.0.1:${PROPOSAL_PORT}`;

  let deliberation: SpawnedService;
  let aiSynthesis: SpawnedService;
  let proposal: SpawnedService;

  beforeAll(async () => {
    [deliberation, aiSynthesis, proposal] = await Promise.all([
      spawnTsService("deliberation-service", DELIBERATION_PORT),
      spawnTsService("ai-synthesis-service", AI_SYNTHESIS_PORT),
      spawnTsService("proposal-service", PROPOSAL_PORT),
    ]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([deliberation?.stop(), aiSynthesis?.stop(), proposal?.stop()]);
  });

  // --- proposal-service client ---
  async function createProposal() {
    const uid = randomUUID();
    return asJson(
      await fetch(`${PROPOSAL_URL}/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          problem_id: `problem-${uid}`,
          title: `Proposal ${uid}`,
          description: "e2e coverage proposal",
          author_id: `author-${uid}`,
        }),
      }),
    );
  }

  // --- deliberation-service client ---
  async function postArgument(proposalId: string, overrides: Record<string, unknown> = {}) {
    return asJson(
      await fetch(`${DELIBERATION_URL}/deliberation/arguments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proposal_id: proposalId,
          citizen_id: `citizen-${randomUUID()}`,
          parent_id: null,
          content: "argument body",
          evidence_ref: "https://example.org/evidence",
          stance: "agreement",
          ...overrides,
        }),
      }),
    );
  }
  async function postPreference(problemId: string, description: string) {
    return asJson(
      await fetch(`${DELIBERATION_URL}/deliberation/preferences`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ problem_id: problemId, citizen_id: `citizen-${randomUUID()}`, description }),
      }),
    );
  }
  async function getArguments(proposalId: string) {
    return asJson(await fetch(`${DELIBERATION_URL}/deliberation/proposals/${proposalId}/arguments`));
  }
  async function getPreferences(problemId: string) {
    return asJson(await fetch(`${DELIBERATION_URL}/deliberation/problems/${problemId}/preferences`));
  }

  // --- ai-synthesis-service client ---
  // The composition step this doc's Overview says doesn't exist yet:
  // deliberation-service's real rows carry many more fields (id, citizen_id,
  // parent_id, locked, created_at, proposal_id) than ai-synthesis-service's
  // /synthesize schema accepts (content/stance/evidence_ref only,
  // additionalProperties:false) -- a verbatim pass-through would 400.
  function toSynthesisArguments(rows: Array<{ content: string; stance: string; evidence_ref: string }>) {
    return rows.map((r) => ({ content: r.content, stance: r.stance, evidence_ref: r.evidence_ref }));
  }
  function toSynthesisPreferences(rows: Array<{ description: string }>) {
    return rows.map((r) => ({ description: r.description }));
  }
  async function synthesize(proposalId: string, args: unknown[], preferences: unknown[]) {
    const res = await fetch(`${AI_SYNTHESIS_URL}/ai-synthesis/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal_id: proposalId, arguments: args, preferences }),
    });
    return { status: res.status, body: await asJson(res) };
  }

  it("HP-4: AI synthesis stays advisory-only, correctly labeled, and built from deliberation-service's real live data", async () => {
    const proposalRecord = await createProposal();
    const proposalId = proposalRecord.id as string;
    const problemId = proposalRecord.problem_id as string;

    const sharedWords = "increases traffic congestion on main street significantly";
    const a1 = await postArgument(proposalId, { stance: "agreement", content: sharedWords, evidence_ref: "ref-1" });
    const a2 = await postArgument(proposalId, { stance: "disagreement", content: sharedWords, evidence_ref: "ref-2" });
    await postArgument(proposalId, { stance: "agreement", content: "a wholly unrelated point", evidence_ref: "ref-3" });
    void a1;
    void a2;

    await postPreference(problemId, "Safer bike lanes on Main St");
    await postPreference(problemId, "safer bike lanes on main st"); // same normalized text -> shared objective

    const realArguments = await getArguments(proposalId);
    const realPreferences = await getPreferences(problemId);
    expect(realArguments).toHaveLength(3);
    expect(realPreferences).toHaveLength(2);

    const result = await synthesize(
      proposalId,
      toSynthesisArguments(realArguments),
      toSynthesisPreferences(realPreferences),
    );
    expect(result.status).toBe(200);
    expect(result.body.label).toBe("AI-generated analysis — advisory only, subject to human review.");
    expect(result.body.model_provenance.model_name).toBe("rule-based-synthesis-v1");
    expect(result.body.shared_objectives.some((o: { count: number }) => o.count === 2)).toBe(true);
    expect(result.body.conflicts.length).toBeGreaterThanOrEqual(1);

    const persisted = await asJson(await fetch(`${AI_SYNTHESIS_URL}/ai-synthesis/outputs/${result.body.id}`));
    expect(persisted.label).toBe(result.body.label);

    // The advisory output never writes back into governance state: the
    // proposal this synthesis was about is untouched.
    const proposalAfter = await asJson(await fetch(`${PROPOSAL_URL}/proposals/${proposalId}`));
    expect(proposalAfter.status).toBe("draft");
  });

  it("HP-6: a citizen journey through constraint-first governance, evidence-linked deliberation, and advisory AI synthesis, en route to voting", async () => {
    const proposalRecord = await createProposal();
    const proposalId = proposalRecord.id as string;
    const problemId = proposalRecord.problem_id as string;

    // FR-029: constraint recorded before any solution debate, while draft.
    const constraintRes = await fetch(`${PROPOSAL_URL}/proposals/${proposalId}/constraints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author_id: "citizen-1", text: "must not increase the tax rate" }),
    });
    expect(constraintRes.status).toBe(201);

    await fetch(`${PROPOSAL_URL}/proposals/${proposalId}/advance`, { method: "POST" }); // -> gathering_support
    await fetch(`${PROPOSAL_URL}/proposals/${proposalId}/scope-assignment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope_jurisdiction_id: "jurisdiction-1", population: 20 }), // threshold = 1
    });
    await fetch(`${PROPOSAL_URL}/proposals/${proposalId}/support`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizen_id: randomUUID() }),
    });
    const toDevelopment = await fetch(`${PROPOSAL_URL}/proposals/${proposalId}/advance`, { method: "POST" }); // -> development
    expect((await asJson(toDevelopment)).status).toBe("development");

    // FR-030: preferences attach to the problem, ahead of/independent from
    // the specific proposal's solution debate.
    await postPreference(problemId, "Reduce commute times");
    await postPreference(problemId, "reduce commute times");

    // FR-028: evidence-linked, mixed-stance arguments; the 5th crosses the
    // default synthesis threshold of 5.
    for (let i = 0; i < 5; i++) {
      await postArgument(proposalId, {
        stance: i % 2 === 0 ? "agreement" : "disagreement",
        content: `argument ${i}`,
        evidence_ref: `https://example.org/evidence-${i}`,
      });
    }

    const realArguments = await getArguments(proposalId);
    const realPreferences = await getPreferences(problemId);
    expect(realArguments).toHaveLength(5);

    const synthesis = await synthesize(proposalId, toSynthesisArguments(realArguments), toSynthesisPreferences(realPreferences));
    expect(synthesis.status).toBe(200);
    expect(synthesis.body.label).toContain("advisory only");

    await fetch(`${PROPOSAL_URL}/proposals/${proposalId}/budget`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cost: 1000,
        funding_source: "general fund",
        maintenance_cost: 50,
        expected_benefits: "shorter commutes",
      }),
    });

    const toVoting = await fetch(`${PROPOSAL_URL}/proposals/${proposalId}/advance`, { method: "POST" }); // -> voting
    expect(toVoting.status).toBe(200);
    expect((await asJson(toVoting)).status).toBe("voting");
  });
});
