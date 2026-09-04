// ARCH-019: Delegated expertise (liquid democracy) -- integration/e2e
// scenarios spanning delegation-service, voting-service, and (for the
// competency-gated create fixture) competency-service. Every service here is
// a real process (see ./harness.ts) reached over real HTTP. Scenario ids
// (HPn) and automated test ids (IT-019-*, E2E-019-*) match
// .spec/technical/architecture/arch-019.md verbatim, including its
// traceability table in section 5.
//
// Scope note: this file covers section 3's four happy-path scenarios only.
// Section 4's 26 edge cases are intentionally left for a follow-up file.
//
// Known gap this file documents rather than works around (arch-019.md
// Overview, confirmed directly against delegation-service/main.go and
// service.go): delegation-service's CompetencyChecker seam has no HTTP
// implementation at all -- main.go always passes `nil` for it, which
// service.go's NewService falls back to `defaultCompetencyChecker` (always
// returns true) for. There is no env var that wires a real one. HP-1 below
// still builds the fixture exactly as arch-019.md §2 specifies (a real
// competency-service, a real application advanced to `active`) so that once
// an HttpCompetencyChecker seam is added, this test starts actually proving
// the gate -- but today it passes regardless of the delegate's real
// competency status, which is the gap, not a test bug.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnGoService, spawnTsService, type SpawnedService } from "./harness.js";

async function asJson(res: Response) {
  return JSON.parse(await res.text());
}

describe("ARCH-019 delegated expertise (delegation-service + voting-service + competency-service)", () => {
  const COMPETENCY_PORT = 49013;
  const DELEGATION_PORT = 49011;
  const VOTING_PORT = 49012;
  const COMPETENCY_URL = `http://127.0.0.1:${COMPETENCY_PORT}`;
  const DELEGATION_URL = `http://127.0.0.1:${DELEGATION_PORT}`;
  const VOTING_URL = `http://127.0.0.1:${VOTING_PORT}`;

  let competency: SpawnedService;
  let delegation: SpawnedService;
  let voting: SpawnedService;

  beforeAll(async () => {
    competency = await spawnTsService("competency-service", COMPETENCY_PORT);
    delegation = await spawnGoService("delegation-service", DELEGATION_PORT);
    // DELEGATION_SERVICE_URL is the one real cross-service seam voting-service
    // actually wires today (remote.go's httpDelegationResolver) -- this is
    // the crux of HP-3 below.
    voting = await spawnGoService("voting-service", VOTING_PORT, {
      DELEGATION_SERVICE_URL: DELEGATION_URL,
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([competency?.stop(), delegation?.stop(), voting?.stop()]);
  });

  // --- competency-service client (fixture steps 1-2) ---
  async function createDomain(name: string) {
    const res = await fetch(`${COMPETENCY_URL}/competency/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description: name }),
    });
    const body = await asJson(res);
    return body.id as string;
  }
  async function grantActiveCompetency(citizenId: string, domainId: string) {
    const applied = await fetch(`${COMPETENCY_URL}/competency/applications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizen_id: citizenId, domain_id: domainId }),
    });
    const { id } = await asJson(applied);
    // application -> automated_credential_check -> public_review_period ->
    // domain_review -> recorded_approval: four advances after the initial
    // `applied` stage reaches `active` (see arch-019.md §2 step 2).
    for (let i = 0; i < 4; i++) {
      await fetch(`${COMPETENCY_URL}/competency/applications/${id}/advance`, { method: "POST" });
    }
  }
  async function hasActiveCompetency(citizenId: string, domainId: string) {
    const res = await fetch(`${COMPETENCY_URL}/competency/citizens/${citizenId}/domains/${domainId}`);
    return (await asJson(res)).active as boolean;
  }

  // --- delegation-service client ---
  async function createDelegation(delegatorId: string, delegateId: string, domainId: string, expiresAt: Date) {
    const res = await fetch(`${DELEGATION_URL}/delegation/delegations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        delegator_id: delegatorId,
        delegate_id: delegateId,
        domain_id: domainId,
        expires_at: expiresAt.toISOString(),
      }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function listDelegations(query: Record<string, string>) {
    const res = await fetch(`${DELEGATION_URL}/delegation/delegations?${new URLSearchParams(query)}`);
    return { status: res.status, body: await asJson(res) };
  }
  async function revokeDelegation(id: string, requestingCitizenId: string) {
    const res = await fetch(`${DELEGATION_URL}/delegation/delegations/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requesting_citizen_id: requestingCitizenId }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function resolveChain(delegateId: string, domainId: string) {
    const res = await fetch(`${DELEGATION_URL}/delegation/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delegate_id: delegateId, domain_id: domainId }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function expireDelegations() {
    const res = await fetch(`${DELEGATION_URL}/delegation/internal/expire`, { method: "POST" });
    return { status: res.status, body: await asJson(res) };
  }

  // --- voting-service client ---
  async function createSession(proposalId: string, jurisdictionId: string) {
    const now = Date.now();
    const res = await fetch(`${VOTING_URL}/voting/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proposal_id: proposalId,
        jurisdiction_id: jurisdictionId,
        method: "approval",
        threshold_rule: "simple_majority",
        min_participation: 0.5,
        cooling_off_until: new Date(now - 60_000).toISOString(),
        opens_at: new Date(now - 30_000).toISOString(),
        closes_at: new Date(now + 3_600_000).toISOString(),
      }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function addOption(sessionId: string, proposalId: string, label: string) {
    const res = await fetch(`${VOTING_URL}/voting/sessions/${sessionId}/options`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal_id: proposalId, label, description: label }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function openSession(sessionId: string, eligibleCitizenIds: string[]) {
    const res = await fetch(`${VOTING_URL}/voting/sessions/${sessionId}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eligible_citizen_ids: eligibleCitizenIds }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function castBallot(sessionId: string, tokenSecret: string, choice: string) {
    const res = await fetch(`${VOTING_URL}/voting/ballots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, token_secret: tokenSecret, choice }),
    });
    return { status: res.status, body: await asJson(res) };
  }

  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

  it("IT-019-HP1: creates a domain-scoped delegation for a competent delegate", async () => {
    const domainId = await createDomain(`hp1-domain-${randomUUID()}`);
    const delegator = `hp1-delegator-${randomUUID()}`;
    const delegate = `hp1-delegate-${randomUUID()}`;
    await grantActiveCompetency(delegate, domainId);
    expect(await hasActiveCompetency(delegate, domainId)).toBe(true);

    const created = await createDelegation(delegator, delegate, domainId, new Date(Date.now() + THIRTY_DAYS));
    expect(created.status).toBe(201);
    expect(created.body.revoked_at).toBeNull();
    expect(created.body.delegator_id).toBe(delegator);
    expect(created.body.delegate_id).toBe(delegate);

    const listed = await listDelegations({ delegator_id: delegator });
    expect(listed.status).toBe(200);
    expect(listed.body.delegations).toHaveLength(1);
    expect(listed.body.delegations[0].id).toBe(created.body.id);
  });

  it("IT-019-HP2: revoking a delegation takes immediate effect and is recorded, not deleted", async () => {
    const domainId = await createDomain(`hp2-domain-${randomUUID()}`);
    const delegator = `hp2-delegator-${randomUUID()}`;
    const delegate = `hp2-delegate-${randomUUID()}`;
    await grantActiveCompetency(delegate, domainId);
    const created = await createDelegation(delegator, delegate, domainId, new Date(Date.now() + THIRTY_DAYS));

    const revoked = await revokeDelegation(created.body.id, delegator);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked_at).not.toBeNull();

    // FR-057: revocation records the row, it never deletes it.
    const listed = await listDelegations({ delegator_id: delegator });
    expect(listed.body.delegations).toHaveLength(1);
    expect(listed.body.delegations[0].id).toBe(created.body.id);
    expect(listed.body.delegations[0].revoked_at).not.toBeNull();
  });

  it("E2E-019-HP3: a transitive 2-hop delegation chain resolves through a real ballot cast", async () => {
    const domainId = await createDomain(`hp3-domain-${randomUUID()}`);
    const a = `hp3-a-${randomUUID()}`;
    const b = `hp3-b-${randomUUID()}`;
    const c = `hp3-c-${randomUUID()}`;
    await grantActiveCompetency(c, domainId);

    const future = new Date(Date.now() + THIRTY_DAYS);
    const abDelegation = await createDelegation(a, b, domainId, future);
    const bcDelegation = await createDelegation(b, c, domainId, future);
    expect(abDelegation.status).toBe(201);
    expect(bcDelegation.status).toBe(201);

    // arch-019.md §2 fixture step 5: the vote session's proposal_id must
    // equal the delegation domain_id, since CastBallot passes
    // session.ProposalID as the resolver's domainID argument -- that's the
    // "domain" workaround this codebase currently requires (Overview gap 1).
    const session = await createSession(domainId, `hp3-jurisdiction-${randomUUID()}`);
    expect(session.status).toBe(201);
    const sessionId = session.body.id as string;

    const option = await addOption(sessionId, domainId, "yes");
    expect(option.status).toBe(201);

    const opened = await openSession(sessionId, [c]);
    expect(opened.status).toBe(200);
    const tokenSecret = opened.body.issued_tokens.find((t: { citizen_id: string }) => t.citizen_id === c)
      .token_secret as string;

    const ballot = await castBallot(sessionId, tokenSecret, option.body.id);
    expect(ballot.status).toBe(201);
    expect(ballot.body.verification_code).toBeTruthy();
    // ADR-002: no citizen_id anywhere in the ballot response.
    expect(ballot.body).not.toHaveProperty("citizen_id");

    // Assert directly against delegation-service (not through voting-service,
    // which discards the resolver's result into Ballot.Weight rather than
    // exposing it -- see arch-019.md §3 HP-3 step 6).
    const resolved = await resolveChain(c, domainId);
    expect(resolved.status).toBe(200);
    // ReverseActiveWalk is a deterministic BFS from c: first hop finds b (the
    // b->c delegation), second hop finds a (the a->b delegation) -- both the
    // direct and the transitive delegator are present, in that order.
    expect(resolved.body.delegator_ids).toEqual([b, a]);
  });

  it("IT-019-HP4: an expired delegation is auto-revoked by the sweep, exactly once", async () => {
    const domainId = await createDomain(`hp4-domain-${randomUUID()}`);
    const delegator = `hp4-delegator-${randomUUID()}`;
    const delegate = `hp4-delegate-${randomUUID()}`;
    await grantActiveCompetency(delegate, domainId);

    const created = await createDelegation(delegator, delegate, domainId, new Date(Date.now() + 1_500));
    expect(created.status).toBe(201);
    expect(created.body.revoked_at).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const firstSweep = await expireDelegations();
    expect(firstSweep.status).toBe(200);
    expect(firstSweep.body.revoked_count).toBeGreaterThanOrEqual(1);

    const listed = await listDelegations({ delegator_id: delegator });
    expect(listed.body.delegations[0].revoked_at).not.toBeNull();

    // EC-19: idempotent -- an immediate repeat sweep must not double-count
    // this same row (already-revoked rows are excluded). No other
    // short-lived delegation exists in this suite's shared store at this
    // point, so the count is exactly 0, matching arch-019.md HP-4 step 3.
    const secondSweep = await expireDelegations();
    expect(secondSweep.status).toBe(200);
    expect(secondSweep.body.revoked_count).toBe(0);
  });
});
