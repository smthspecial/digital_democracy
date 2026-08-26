import { describe, expect, it, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";

async function createDomain(app: ReturnType<typeof buildServer>) {
  const res = await app.inject({
    method: "POST",
    url: "/competency/domains",
    payload: { name: "transportation", description: "desc" },
  });
  return res.json().id as string;
}

async function grantActiveCompetency(app: ReturnType<typeof buildServer>, domainId: string, citizenId: string) {
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

describe("competency challenge routes", () => {
  const store = createStore();
  const app = buildServer({ store });

  afterAll(async () => {
    await app.close();
  });

  it("submits a challenge with status=open", async () => {
    const domainId = await createDomain(app);
    const competencyId = await grantActiveCompetency(app, domainId, "citizen-expert");

    const res = await app.inject({
      method: "POST",
      url: "/competency/challenges",
      payload: {
        competency_id: competencyId,
        challenger_id: "citizen-challenger",
        reason: "credentials",
        evidence_ref: "https://evidence.example/doc",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      competency_id: competencyId,
      challenger_id: "citizen-challenger",
      reason: "credentials",
      status: "open",
    });
  });

  it("rejects an anonymous evidence-free challenge", async () => {
    const domainId = await createDomain(app);
    const competencyId = await grantActiveCompetency(app, domainId, "citizen-expert-2");

    const res = await app.inject({
      method: "POST",
      url: "/competency/challenges",
      payload: {
        competency_id: competencyId,
        challenger_id: "citizen-challenger-2",
        reason: "misconduct",
        evidence_ref: "",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("upheld resolution revokes the target competency", async () => {
    const domainId = await createDomain(app);
    const competencyId = await grantActiveCompetency(app, domainId, "citizen-expert-3");
    const challengeRes = await app.inject({
      method: "POST",
      url: "/competency/challenges",
      payload: {
        competency_id: competencyId,
        challenger_id: "citizen-challenger-3",
        reason: "false_claim",
        evidence_ref: "https://evidence.example/doc-3",
      },
    });
    const challengeId = challengeRes.json().id;

    const resolveRes = await app.inject({
      method: "POST",
      url: `/competency/challenges/${challengeId}/resolve`,
      payload: { result: "upheld" },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().status).toBe("upheld");

    const statusRes = await app.inject({
      method: "GET",
      url: `/competency/citizens/citizen-expert-3/domains/${domainId}`,
    });
    expect(statusRes.json()).toEqual({ active: false });
  });

  it("dismissed resolution does not revoke the target competency", async () => {
    const domainId = await createDomain(app);
    const competencyId = await grantActiveCompetency(app, domainId, "citizen-expert-4");
    const challengeRes = await app.inject({
      method: "POST",
      url: "/competency/challenges",
      payload: {
        competency_id: competencyId,
        challenger_id: "citizen-challenger-4",
        reason: "conflict",
        evidence_ref: "https://evidence.example/doc-4",
      },
    });
    const challengeId = challengeRes.json().id;

    const resolveRes = await app.inject({
      method: "POST",
      url: `/competency/challenges/${challengeId}/resolve`,
      payload: { result: "dismissed" },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().status).toBe("dismissed");

    const statusRes = await app.inject({
      method: "GET",
      url: `/competency/citizens/citizen-expert-4/domains/${domainId}`,
    });
    expect(statusRes.json()).toEqual({ active: true });
  });

  it("404s submitting a challenge against an unknown competency", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/competency/challenges",
      payload: {
        competency_id: "nonexistent",
        challenger_id: "citizen-challenger-5",
        reason: "credentials",
        evidence_ref: "https://evidence.example/doc-5",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s resolving an already-resolved challenge", async () => {
    const domainId = await createDomain(app);
    const competencyId = await grantActiveCompetency(app, domainId, "citizen-expert-6");
    const challengeRes = await app.inject({
      method: "POST",
      url: "/competency/challenges",
      payload: {
        competency_id: competencyId,
        challenger_id: "citizen-challenger-6",
        reason: "credentials",
        evidence_ref: "https://evidence.example/doc-6",
      },
    });
    const challengeId = challengeRes.json().id;
    await app.inject({
      method: "POST",
      url: `/competency/challenges/${challengeId}/resolve`,
      payload: { result: "dismissed" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/competency/challenges/${challengeId}/resolve`,
      payload: { result: "upheld" },
    });
    expect(res.statusCode).toBe(409);
  });
});
