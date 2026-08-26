import { describe, expect, it, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";

async function createDomain(app: ReturnType<typeof buildServer>, name = "transportation") {
  const res = await app.inject({
    method: "POST",
    url: "/competency/domains",
    payload: { name, description: "desc" },
  });
  return res.json().id as string;
}

async function grantActiveCompetency(
  app: ReturnType<typeof buildServer>,
  domainId: string,
  citizenId: string,
) {
  const appRes = await app.inject({
    method: "POST",
    url: "/competency/applications",
    payload: { citizen_id: citizenId, domain_id: domainId },
  });
  const competencyId = appRes.json().id;
  for (let i = 0; i < 4; i++) {
    await app.inject({ method: "POST", url: `/competency/applications/${competencyId}/advance` });
  }
  return competencyId;
}

describe("expert assessment routes", () => {
  const store = createStore();
  const app = buildServer({ store });

  afterAll(async () => {
    await app.close();
  });

  it("403s publishing without an active competency in the domain", async () => {
    const domainId = await createDomain(app);
    const res = await app.inject({
      method: "POST",
      url: "/competency/assessments",
      payload: {
        proposal_id: "proposal-1",
        citizen_id: "citizen-no-competency",
        domain_id: domainId,
        content: "This looks technically sound.",
        score: 8,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s publishing with an undisclosed conflict of interest in the domain", async () => {
    const domainId = await createDomain(app, "healthcare");
    await grantActiveCompetency(app, domainId, "citizen-conflicted");
    await app.inject({
      method: "POST",
      url: "/competency/conflicts",
      payload: { citizen_id: "citizen-conflicted", domain_id: domainId, description: "Consulting fee" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/competency/assessments",
      payload: {
        proposal_id: "proposal-2",
        citizen_id: "citizen-conflicted",
        domain_id: domainId,
        content: "Analysis text",
        score: 5,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("publishes when the citizen has an active competency and no conflict of interest", async () => {
    const domainId = await createDomain(app, "energy");
    await grantActiveCompetency(app, domainId, "citizen-clean");

    const res = await app.inject({
      method: "POST",
      url: "/competency/assessments",
      payload: {
        proposal_id: "proposal-3",
        citizen_id: "citizen-clean",
        domain_id: domainId,
        content: "Feasible with moderate funding.",
        score: 7,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      proposal_id: "proposal-3",
      citizen_id: "citizen-clean",
      domain_id: domainId,
      content: "Feasible with moderate funding.",
      score: 7,
    });
  });
});
