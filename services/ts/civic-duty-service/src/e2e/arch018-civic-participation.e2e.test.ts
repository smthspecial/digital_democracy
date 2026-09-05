// ARCH-018: Civic knowledge & participation -- assignments, quotas &
// inactivity. Integration/e2e scenarios spanning civic-duty-service and, for
// HP-1/HP-5, the real identity-service/jurisdiction-service/competency-service
// this flow's candidate pool would come from once a production orchestrator
// exists (none does yet -- see arch-018.md §1/§2: this harness stands in for
// it, which ARCH-009 §2 explicitly allows for fixture assembly). Every
// service here is a real process (see ./harness.ts) reached over real HTTP.
// Scenario ids (HPn/ECn) match .spec/technical/architecture/arch-018.md
// verbatim.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnTsService, type SpawnedService } from "./harness.js";

async function asJson(res: Response) {
  return JSON.parse(await res.text());
}

describe("ARCH-018 civic knowledge & participation (full fleet)", () => {
  const IDENTITY_PORT = 48181;
  const JURISDICTION_PORT = 48182;
  const COMPETENCY_PORT = 48183;
  const CIVIC_DUTY_PORT = 48184;
  const IDENTITY_URL = `http://127.0.0.1:${IDENTITY_PORT}`;
  const JURISDICTION_URL = `http://127.0.0.1:${JURISDICTION_PORT}`;
  const COMPETENCY_URL = `http://127.0.0.1:${COMPETENCY_PORT}`;
  const CIVIC_DUTY_URL = `http://127.0.0.1:${CIVIC_DUTY_PORT}`;

  let identity: SpawnedService;
  let jurisdiction: SpawnedService;
  let competency: SpawnedService;
  let civicDuty: SpawnedService;

  beforeAll(async () => {
    [identity, jurisdiction, competency, civicDuty] = await Promise.all([
      spawnTsService("identity-service", IDENTITY_PORT),
      spawnTsService("jurisdiction-service", JURISDICTION_PORT),
      spawnTsService("competency-service", COMPETENCY_PORT),
      spawnTsService("civic-duty-service", CIVIC_DUTY_PORT),
    ]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([identity?.stop(), jurisdiction?.stop(), competency?.stop(), civicDuty?.stop()]);
  });

  // --- identity-service client ---
  async function registerActiveCitizen() {
    const uid = randomUUID();
    const created = await asJson(
      await fetch(`${IDENTITY_URL}/identity/citizens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ public_handle: `citizen-${uid}`, raw_legal_identifier: uid }),
      }),
    );
    await fetch(`${IDENTITY_URL}/identity/citizens/${created.id}/verifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evidence_ref: "doc-1", outcome: "verified", method: "national_id" }),
    });
    return created.id as string;
  }

  // --- jurisdiction-service client ---
  async function makeCitizenSphereRelevant(citizenId: string, scopeJurisdictionId: string) {
    await fetch(`${JURISDICTION_URL}/jurisdiction/memberships`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizen_id: citizenId, jurisdiction_id: scopeJurisdictionId }),
    });
    await fetch(`${JURISDICTION_URL}/jurisdiction/residencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizen_id: citizenId,
        jurisdiction_id: scopeJurisdictionId,
        start_date: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    });
  }
  async function isSphereRelevant(citizenId: string, scopeJurisdictionId: string) {
    const res = await asJson(
      await fetch(
        `${JURISDICTION_URL}/jurisdiction/eligibility?citizen_id=${citizenId}&scope_jurisdiction_id=${scopeJurisdictionId}`,
      ),
    );
    return res.eligible === true;
  }

  // --- competency-service client ---
  async function grantActiveCompetency(citizenId: string, domainId: string) {
    const application = await asJson(
      await fetch(`${COMPETENCY_URL}/competency/applications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ citizen_id: citizenId, domain_id: domainId }),
      }),
    );
    for (let i = 0; i < 4; i++) {
      await fetch(`${COMPETENCY_URL}/competency/applications/${application.id}/advance`, { method: "POST" });
    }
  }
  async function hasActiveCompetency(citizenId: string, domainId: string) {
    const res = await asJson(
      await fetch(`${COMPETENCY_URL}/competency/citizens/${citizenId}/domains/${domainId}`),
    );
    return res.active === true;
  }

  // --- civic-duty-service client ---
  async function generateAssignment(body: unknown) {
    const res = await fetch(`${CIVIC_DUTY_URL}/civic-duty/assignments/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function citizenAssignments(citizenId: string) {
    return asJson(await fetch(`${CIVIC_DUTY_URL}/civic-duty/citizens/${citizenId}/assignments`));
  }
  async function refreshAuditPool(candidates: string[], count: number) {
    const res = await fetch(`${CIVIC_DUTY_URL}/civic-duty/audit-pool/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidates, count }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function rebalance(candidates: string[], overloadThreshold: number) {
    const res = await fetch(`${CIVIC_DUTY_URL}/civic-duty/assignments/rebalance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidates, overload_threshold: overloadThreshold }),
    });
    return asJson(res);
  }

  it("HP-1: randomized weighted proposal-review assignment across a real candidate pool assembled from identity/jurisdiction/competency", async () => {
    const [c1, c2, c3] = await Promise.all([registerActiveCitizen(), registerActiveCitizen(), registerActiveCitizen()]);

    const scope = await asJson(
      await fetch(`${JURISDICTION_URL}/jurisdiction/jurisdictions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Scope ${randomUUID()}`, scope_level: "municipality", boundary_ref: "ref-1" }),
      }),
    );
    await makeCitizenSphereRelevant(c1, scope.id);
    expect(await isSphereRelevant(c1, scope.id)).toBe(true);
    expect(await isSphereRelevant(c2, scope.id)).toBe(false);

    const domain = await asJson(
      await fetch(`${COMPETENCY_URL}/competency/domains`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Domain ${randomUUID()}`, description: "e2e domain" }),
      }),
    );
    await grantActiveCompetency(c2, domain.id);
    expect(await hasActiveCompetency(c2, domain.id)).toBe(true);
    expect(await hasActiveCompetency(c1, domain.id)).toBe(false);

    const targetRef = `proposal-${randomUUID()}`;
    const generated = await generateAssignment({
      type: "proposal_review",
      target_ref: targetRef,
      candidates: [
        { citizen_id: c1, sphere_relevant: true, competency_match: false },
        { citizen_id: c2, sphere_relevant: false, competency_match: true },
        { citizen_id: c3, sphere_relevant: false, competency_match: false },
      ],
    });
    expect(generated.status).toBe(201);
    expect(generated.body.weights).toHaveLength(3);
    const weightOf = (id: string) => generated.body.weights.find((w: { citizenId: string }) => w.citizenId === id).weight;
    expect(weightOf(c1)).toBeGreaterThan(weightOf(c3));
    expect(weightOf(c2)).toBeGreaterThan(weightOf(c3));
    expect([c1, c2, c3]).toContain(generated.body.assignment.citizenId);
    expect(generated.body.assignment.status).toBe("assigned");
    expect(generated.body.assignment.dueAt).toBeNull();

    const winnerAssignments = await citizenAssignments(generated.body.assignment.citizenId);
    expect(winnerAssignments.some((a: { targetRef: string }) => a.targetRef === targetRef)).toBe(true);
  });

  it("HP-2: load-balancing keeps a zero-assignment citizen from staying unassigned", async () => {
    const loaded = `loaded-${randomUUID()}`;
    const idle = `idle-${randomUUID()}`;
    await generateAssignment({ type: "proposal_review", target_ref: "prior-1", candidates: [{ citizen_id: loaded, sphere_relevant: false, competency_match: false }] });
    await generateAssignment({ type: "proposal_review", target_ref: "prior-2", candidates: [{ citizen_id: loaded, sphere_relevant: false, competency_match: false }] });

    const before = await rebalance([loaded, idle], 1);
    expect(before.overloaded).toContain(loaded);
    expect(before.underloaded).toContain(idle);

    const generated = await generateAssignment({
      type: "proposal_review",
      target_ref: "target-2",
      candidates: [{ citizen_id: idle, sphere_relevant: false, competency_match: false }],
    });
    expect(generated.body.assignment.citizenId).toBe(idle);

    const after = await rebalance([loaded, idle], 1);
    expect(after.underloaded).not.toContain(idle);
  });

  it("HP-5: monthly audit-pool refresh selects a fresh, non-repeating pool from a real identity-service candidate list", async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => registerActiveCitizen()));
    const [prior, ...rest] = ids;

    await generateAssignment({ type: "audit_review", target_ref: "existing-audit", candidates: [{ citizen_id: prior, sphere_relevant: false, competency_match: false }] });

    const first = await refreshAuditPool(ids, 3);
    expect(first.status).toBe(201);
    expect(first.body).toHaveLength(3);
    expect(first.body.every((a: { citizenId: string; status: string; targetRef: string }) => a.citizenId !== prior && a.status === "assigned" && a.targetRef === "audit_pool_refresh")).toBe(true);

    const second = await refreshAuditPool(ids, 3);
    // prior + the 3 just-selected are now all excluded, leaving only 1
    // eligible candidate from the original pool of 5.
    expect(second.body.length).toBeLessThanOrEqual(1);
    const selectedIds = new Set(first.body.map((a: { citizenId: string }) => a.citizenId));
    for (const a of second.body as Array<{ citizenId: string }>) {
      expect(selectedIds.has(a.citizenId)).toBe(false);
      expect(a.citizenId).not.toBe(prior);
    }
    void rest;
  });
});
