// ARCH-020: Constitutional layer -- protected rights & constitutional
// review. Integration/e2e scenarios spanning audit-service (real DP-034
// keyword-match review, Go) and proposal-service (the real
// HttpConstitutionalReviewer seam, TS). Every service here is a real
// process (see ./harness.ts) reached over real HTTP -- this is the first
// test in the repo to exercise advance()'s constitutional-review call
// against a live audit-service rather than an in-process fake reviewer
// (contrast with proposals.test.ts's "development -> voting is blocked
// when the constitutional reviewer blocks it", which stubs the seam).
// Scenario ids (HPn/ECn) match .spec/technical/architecture/arch-020.md
// verbatim. HP-3 (the voting-service supermajority leg) is not covered
// here: VoteSessionRequester is still a no-op in proposal-service, so no
// vote session is ever actually created to test against -- see arch-020.md
// EC-24/Status update. HP-4 (the deadlock framework's constitutional_review
// stage as the last checkpoint before final_decision) needs no real
// audit-service call at all (arch-020.md EC-25: the deadlock stage never
// consults it) and is already covered by proposals.test.ts's "resolves the
// proposal when an outcome is provided at final_decision, bypassing normal
// gates" test.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnGoService, spawnTsService, type SpawnedService } from "./harness.js";

async function asJson(res: Response) {
  return JSON.parse(await res.text());
}

describe("ARCH-020 constitutional review (real audit-service + proposal-service)", () => {
  const AUDIT_PORT = 48220;
  const PROPOSAL_PORT = 48222;
  const AUDIT_URL = `http://127.0.0.1:${AUDIT_PORT}`;
  const PROPOSAL_URL = `http://127.0.0.1:${PROPOSAL_PORT}`;

  let audit: SpawnedService;
  let proposal: SpawnedService;

  beforeAll(async () => {
    audit = await spawnGoService("audit-service", AUDIT_PORT);
    proposal = await spawnTsService("proposal-service", PROPOSAL_PORT, {
      AUDIT_SERVICE_URL: AUDIT_URL,
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([audit?.stop(), proposal?.stop()]);
  });

  // --- audit-service client ---
  async function createRight(name: string, protectedRight = true) {
    const res = await fetch(`${AUDIT_URL}/audit/rights`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description: `protects ${name}`, protected: protectedRight }),
    });
    return asJson(res);
  }
  async function auditLog(actionType?: string) {
    const url = actionType ? `${AUDIT_URL}/audit/log?action_type=${actionType}` : `${AUDIT_URL}/audit/log`;
    const res = await fetch(url);
    return asJson(res);
  }
  async function verifyChain() {
    const res = await fetch(`${AUDIT_URL}/audit/log/verify`);
    return asJson(res);
  }

  // --- proposal-service client ---
  async function createProposal(title: string, description: string) {
    const uid = randomUUID();
    const res = await fetch(`${PROPOSAL_URL}/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        problem_id: `problem-${uid}`,
        title,
        description,
        author_id: `author-${uid}`,
      }),
    });
    return asJson(res);
  }
  async function advanceToDevelopment(id: string) {
    await fetch(`${PROPOSAL_URL}/proposals/${id}/advance`, { method: "POST" }); // draft -> gathering_support
    await fetch(`${PROPOSAL_URL}/proposals/${id}/scope-assignment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope_jurisdiction_id: "jurisdiction-1", population: 20 }), // threshold = 1
    });
    await fetch(`${PROPOSAL_URL}/proposals/${id}/support`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizen_id: randomUUID() }),
    });
    await fetch(`${PROPOSAL_URL}/proposals/${id}/advance`, { method: "POST" }); // -> development
    await fetch(`${PROPOSAL_URL}/proposals/${id}/budget`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cost: 1000,
        funding_source: "general fund",
        maintenance_cost: 50,
        expected_benefits: "fewer potholes",
      }),
    });
  }
  async function advanceToVoting(id: string) {
    const res = await fetch(`${PROPOSAL_URL}/proposals/${id}/advance`, { method: "POST" });
    return { status: res.status, body: await asJson(res) };
  }
  async function getProposal(id: string) {
    const res = await fetch(`${PROPOSAL_URL}/proposals/${id}`);
    return asJson(res);
  }

  it("HP-1: a non-conflicting proposal really clears DP-034 against a live audit-service and advances to voting", async () => {
    await createRight(`freedom of assembly ${randomUUID()}`);
    const before = await auditLog("rule_change");

    const created = await createProposal(
      `Repave Main Street ${randomUUID()}`,
      "Fix the potholes on Main Street before winter",
    );
    await advanceToDevelopment(created.id);

    const advanced = await advanceToVoting(created.id);
    expect(advanced.status).toBe(200);
    expect(advanced.body.status).toBe("voting");

    const read = await getProposal(created.id);
    expect(read.status).toBe("voting");

    // DP-036: the review itself lands in the real, hash-chained audit log
    // (one `rule_change` entry per protected right existing at review time;
    // NFR-001 means only a payload_hash is retrievable, not the content
    // itself, so presence/count is what's checkable from outside).
    const after = await auditLog("rule_change");
    expect(after.entries.length).toBeGreaterThan(before.entries.length);
    const verify = await verifyChain();
    expect(verify.valid).toBe(true);
  });

  it("HP-2: a rights-violating proposal is really blocked by a live audit-service; a competing, compliant proposal on the same problem clears instead", async () => {
    const rightName = `freedom of speech ${randomUUID()}`;
    await createRight(rightName);
    const problemId = `problem-${randomUUID()}`;

    // Proposal A's derived change_summary (title + description) literally
    // contains the protected right's name -- the one thing audit-service's
    // keywordMatchAssessor actually checks for.
    const proposalA = await (async () => {
      const res = await fetch(`${PROPOSAL_URL}/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          problem_id: problemId,
          title: "Restrict public commentary",
          description: `Citizens may no longer exercise their ${rightName} on this platform.`,
          author_id: `author-${randomUUID()}`,
        }),
      });
      return asJson(res);
    })();

    await advanceToDevelopment(proposalA.id);
    const blockedResult = await advanceToVoting(proposalA.id);
    expect(blockedResult.status).toBe(409);
    expect(blockedResult.body.error).toMatch(/blocked by constitutional review/);

    const readA = await getProposal(proposalA.id);
    expect(readA.status).toBe("development");

    const proposalB = await (async () => {
      const res = await fetch(`${PROPOSAL_URL}/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          problem_id: problemId,
          title: "Add more streetlights",
          description: "Install additional streetlights along the corridor",
          author_id: `author-${randomUUID()}`,
        }),
      });
      return asJson(res);
    })();
    await advanceToDevelopment(proposalB.id);
    const clearedResult = await advanceToVoting(proposalB.id);
    expect(clearedResult.status).toBe(200);
    expect(clearedResult.body.status).toBe("voting");
  });

  // EC-23: audit-service down/unreachable when HttpConstitutionalReviewer
  // calls it -- must fail closed (proposal does not advance), not silently
  // let the proposal through. Uses a second proposal-service instance
  // pointed at a port nothing is listening on, rather than stopping the
  // real audit-service, so it doesn't disturb the other tests in this file.
  it("EC-23: fails closed (does not advance) when audit-service is unreachable during the constitutional-review call", async () => {
    const DEAD_AUDIT_URL = "http://127.0.0.1:48221"; // nothing listens here
    const UNREACHABLE_PROPOSAL_PORT = 48224;
    const unreachableProposal = await spawnTsService("proposal-service", UNREACHABLE_PROPOSAL_PORT, {
      AUDIT_SERVICE_URL: DEAD_AUDIT_URL,
    });
    try {
      const url = `http://127.0.0.1:${UNREACHABLE_PROPOSAL_PORT}`;
      const created = await (
        await fetch(`${url}/proposals`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            problem_id: `problem-${randomUUID()}`,
            title: "Repave Elm Street",
            description: "Fix the potholes on Elm Street",
            author_id: `author-${randomUUID()}`,
          }),
        })
      ).json();
      await fetch(`${url}/proposals/${created.id}/advance`, { method: "POST" });
      await fetch(`${url}/proposals/${created.id}/scope-assignment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope_jurisdiction_id: "jurisdiction-1", population: 20 }),
      });
      await fetch(`${url}/proposals/${created.id}/support`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ citizen_id: randomUUID() }),
      });
      await fetch(`${url}/proposals/${created.id}/advance`, { method: "POST" }); // -> development
      await fetch(`${url}/proposals/${created.id}/budget`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cost: 1000,
          funding_source: "general fund",
          maintenance_cost: 50,
          expected_benefits: "fewer potholes",
        }),
      });

      const attempt = await fetch(`${url}/proposals/${created.id}/advance`, { method: "POST" });
      expect(attempt.status).not.toBe(200);

      const read = await asJson(await fetch(`${url}/proposals/${created.id}`));
      expect(read.status).toBe("development");
    } finally {
      await unreachableProposal.stop();
    }
  });
});
