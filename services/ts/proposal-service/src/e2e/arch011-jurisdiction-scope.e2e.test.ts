// ARCH-011: Sphere of impact -- jurisdiction, residency & scope assignment.
// Integration/e2e scenarios spanning jurisdiction-service, proposal-service,
// and (for EC-31) governance-role-service. Every service here is a real
// process (see ./harness.ts) reached over real HTTP. Scenario ids (HPn/ECn)
// match .spec/technical/architecture/arch-011.md verbatim.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnTsService, type SpawnedService } from "./harness.js";

async function asJson(res: Response) {
  return JSON.parse(await res.text());
}

describe("ARCH-011 sphere of impact (full fleet)", () => {
  const JURISDICTION_PORT = 48511;
  const PROPOSAL_PORT = 48514;
  const GOVERNANCE_PORT = 48519;
  const JURISDICTION_URL = `http://127.0.0.1:${JURISDICTION_PORT}`;
  const PROPOSAL_URL = `http://127.0.0.1:${PROPOSAL_PORT}`;
  const GOVERNANCE_URL = `http://127.0.0.1:${GOVERNANCE_PORT}`;

  let jurisdiction: SpawnedService;
  let proposal: SpawnedService;
  let governance: SpawnedService;

  beforeAll(async () => {
    governance = await spawnTsService("governance-role-service", GOVERNANCE_PORT);
    jurisdiction = await spawnTsService("jurisdiction-service", JURISDICTION_PORT, {
      GOVERNANCE_ROLE_SERVICE_URL: GOVERNANCE_URL,
    });
    proposal = await spawnTsService("proposal-service", PROPOSAL_PORT, {
      JURISDICTION_SERVICE_URL: JURISDICTION_URL,
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([jurisdiction?.stop(), proposal?.stop(), governance?.stop()]);
  });

  // --- jurisdiction-service client ---
  async function createJurisdiction(parentId: string | null, name: string, scopeLevel: string) {
    const res = await fetch(`${JURISDICTION_URL}/jurisdiction/jurisdictions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent_id: parentId, name, scope_level: scopeLevel, boundary_ref: `ref-${name}` }),
    });
    return asJson(res);
  }
  async function addMembership(citizenId: string, jurisdictionId: string) {
    return fetch(`${JURISDICTION_URL}/jurisdiction/memberships`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizen_id: citizenId, jurisdiction_id: jurisdictionId }),
    });
  }
  function daysAgo(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }
  async function addResidency(citizenId: string, jurisdictionId: string, startDate: string) {
    return fetch(`${JURISDICTION_URL}/jurisdiction/residencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizen_id: citizenId, jurisdiction_id: jurisdictionId, start_date: startDate }),
    });
  }
  async function checkEligibility(citizenId: string, scopeJurisdictionId: string) {
    const query = new URLSearchParams({ citizen_id: citizenId, scope_jurisdiction_id: scopeJurisdictionId });
    const res = await fetch(`${JURISDICTION_URL}/jurisdiction/eligibility?${query.toString()}`);
    return asJson(res);
  }

  // --- proposal-service client ---
  async function createProposal() {
    const uid = randomUUID();
    const res = await fetch(`${PROPOSAL_URL}/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        problem_id: `problem-${uid}`,
        title: `Test proposal ${uid}`,
        description: "A proposal for ARCH-011 e2e coverage",
        author_id: `author-${uid}`,
      }),
    });
    return asJson(res);
  }
  async function advanceProposal(id: string) {
    const res = await fetch(`${PROPOSAL_URL}/proposals/${id}/advance`, { method: "POST" });
    return { status: res.status, body: await asJson(res) };
  }
  async function assignScope(id: string, scopeJurisdictionId: string, population: number) {
    const res = await fetch(`${PROPOSAL_URL}/proposals/${id}/scope-assignment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope_jurisdiction_id: scopeJurisdictionId, population }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function getProposal(id: string) {
    const res = await fetch(`${PROPOSAL_URL}/proposals/${id}`);
    return { status: res.status, body: await asJson(res) };
  }

  // --- governance-role-service client (for EC-31) ---
  async function createRole(citizenId: string, roleType: string, layer: string) {
    const res = await fetch(`${GOVERNANCE_URL}/governance-roles/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizen_id: citizenId,
        role_type: roleType,
        layer,
        randomized: false,
        term_start: "2020-01-01T00:00:00.000Z",
        term_end: "2035-01-01T00:00:00.000Z",
      }),
    });
    const body = await asJson(res);
    return body.id as string;
  }
  async function submitApproval(actionRef: string, approverRoleId: string, approvalType: string) {
    return fetch(`${GOVERNANCE_URL}/governance-roles/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action_ref: actionRef,
        approver_role_id: approverRoleId,
        approval_type: approvalType,
        decision: "approved",
      }),
    });
  }
  const APPROVAL_TYPES = [
    { type: "citizen_supermajority", layer: "citizen", roleType: "reviewer" },
    { type: "audit_confirmation", layer: "audit", roleType: "auditor" },
    { type: "body_endorsement", layer: "protocol", roleType: "review_body" },
  ] as const;
  async function fullyApproveJurisdictionScopeLevel(jurisdictionId: string) {
    const actionRef = `jurisdiction:scope-level:${jurisdictionId}`;
    for (const { type, layer, roleType } of APPROVAL_TYPES) {
      const roleId = await createRole(`approver-${randomUUID()}`, roleType, layer);
      const res = await submitApproval(actionRef, roleId, type);
      if (res.status !== 201) {
        throw new Error(`approval ${type} for ${actionRef} failed: ${res.status}`);
      }
    }
  }

  it("HP-1: smallest-competent-jurisdiction scope assignment with population-scaled threshold", async () => {
    const nation = await createJurisdiction(null, `Nation-${randomUUID()}`, "national");
    const region = await createJurisdiction(nation.id, `Region-${randomUUID()}`, "regional");
    const city = await createJurisdiction(region.id, `City-${randomUUID()}`, "municipality");

    const proposalRecord = await createProposal();
    await advanceProposal(proposalRecord.id); // draft -> gathering_support

    const assigned = await assignScope(proposalRecord.id, city.id, 1000);
    expect(assigned.status).toBe(200);
    expect(assigned.body.scope_jurisdiction_id).toBe(city.id);
    expect(assigned.body.support_threshold).toBe(50);
  });

  it("HP-2: assigned scope is publicly visible on the proposal", async () => {
    const city = await createJurisdiction(null, `City-hp2-${randomUUID()}`, "municipality");
    const proposalRecord = await createProposal();
    await advanceProposal(proposalRecord.id);
    await assignScope(proposalRecord.id, city.id, 1000);

    const read = await getProposal(proposalRecord.id);
    expect(read.status).toBe(200);
    expect(read.body.scope_jurisdiction_id).toBe(city.id);
    expect(read.body.support_threshold).toBe(50);
  });

  it("HP-4: multi-jurisdiction simultaneous membership, evaluated independently per proposal", async () => {
    const citizenId = `citizen-${randomUUID()}`;
    const nation = await createJurisdiction(null, `Nation-hp4-${randomUUID()}`, "national");
    const region = await createJurisdiction(nation.id, `Region-hp4-${randomUUID()}`, "regional");
    const city = await createJurisdiction(region.id, `City-hp4-${randomUUID()}`, "municipality");

    await addMembership(citizenId, city.id);
    await addResidency(citizenId, city.id, daysAgo(60));
    await addMembership(citizenId, nation.id);
    await addResidency(citizenId, nation.id, daysAgo(60));

    const proposalA = await createProposal();
    await assignScope(proposalA.id, city.id, 100);
    const proposalB = await createProposal();
    await assignScope(proposalB.id, nation.id, 100);

    const eligibleCity = await checkEligibility(citizenId, city.id);
    const eligibleNation = await checkEligibility(citizenId, nation.id);
    expect(eligibleCity.eligible).toBe(true);
    expect(eligibleNation.eligible).toBe(true);
  });

  it("IT-011-EC-5: assignScope rejects a scope_jurisdiction_id that doesn't exist in the real jurisdiction-service", async () => {
    const proposalRecord = await createProposal();
    const res = await assignScope(proposalRecord.id, "00000000-0000-0000-0000-000000000000", 100);
    expect(res.status).toBe(400);
  });

  it("IT-011-EC-31: a scope-level change succeeds once fully approved by the real governance-role-service", async () => {
    const jurisdiction2 = await createJurisdiction(null, `Gated-${randomUUID()}`, "municipality");
    await fullyApproveJurisdictionScopeLevel(jurisdiction2.id);

    const res = await fetch(`${JURISDICTION_URL}/jurisdiction/jurisdictions/${jurisdiction2.id}/scope-level`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope_level: "regional" }),
    });
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.scope_level).toBe("regional");
  });

  it("IT-011-EC-31: a scope-level change is denied when governance-role-service has not fully approved it", async () => {
    const jurisdiction3 = await createJurisdiction(null, `Ungated-${randomUUID()}`, "municipality");
    // No approvals submitted at all.
    const res = await fetch(`${JURISDICTION_URL}/jurisdiction/jurisdictions/${jurisdiction3.id}/scope-level`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope_level: "regional" }),
    });
    expect(res.status).toBe(403);
  });
});
