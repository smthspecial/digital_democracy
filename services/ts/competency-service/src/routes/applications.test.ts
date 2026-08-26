import { describe, expect, it, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";

async function createDomain(app: ReturnType<typeof buildServer>) {
  const res = await app.inject({
    method: "POST",
    url: "/competency/domains",
    payload: { name: "transportation", description: "Roads and transit" },
  });
  return res.json().id as string;
}

async function apply(app: ReturnType<typeof buildServer>, domainId: string, citizenId = "citizen-1") {
  const res = await app.inject({
    method: "POST",
    url: "/competency/applications",
    payload: { citizen_id: citizenId, domain_id: domainId },
  });
  return res.json();
}

describe("application routes", () => {
  const store = createStore();
  const app = buildServer({ store });

  afterAll(async () => {
    await app.close();
  });

  it("POST /competency/applications creates a competency with status=applied, stage=application", async () => {
    const domainId = await createDomain(app);
    const res = await app.inject({
      method: "POST",
      url: "/competency/applications",
      payload: { citizen_id: "citizen-1", domain_id: domainId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      citizen_id: "citizen-1",
      domain_id: domainId,
      status: "applied",
      stage: "application",
      granted_at: null,
      expires_at: null,
    });
  });

  it("404s applying against an unknown domain", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/competency/applications",
      payload: { citizen_id: "citizen-1", domain_id: "nonexistent-domain" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("advances through every stage in strict sequential order, completing the pipeline as active with expires_at set", async () => {
    const domainId = await createDomain(app);
    const competency = await apply(app, domainId);

    const stages = [
      "automated_credential_check",
      "public_review_period",
      "domain_review",
      "recorded_approval",
    ];

    let last = competency;
    for (const expectedStage of stages) {
      const res = await app.inject({
        method: "POST",
        url: `/competency/applications/${competency.id}/advance`,
      });
      expect(res.statusCode).toBe(200);
      last = res.json();
      expect(last.stage).toBe(expectedStage);
    }

    expect(last.status).toBe("active");
    expect(last.granted_at).toBeTypeOf("string");
    expect(last.expires_at).toBeTypeOf("string");
    expect(new Date(last.expires_at).getTime()).toBeGreaterThan(new Date(last.granted_at).getTime());
  });

  it("409s advancing an already-active (fully advanced) competency", async () => {
    const domainId = await createDomain(app);
    const competency = await apply(app, domainId);
    for (let i = 0; i < 4; i++) {
      await app.inject({ method: "POST", url: `/competency/applications/${competency.id}/advance` });
    }
    const res = await app.inject({
      method: "POST",
      url: `/competency/applications/${competency.id}/advance`,
    });
    expect(res.statusCode).toBe(409);
  });

  it("404s advancing an unknown application", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/competency/applications/does-not-exist/advance",
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an application at any non-terminal stage, halting the pipeline", async () => {
    const domainId = await createDomain(app);
    const competency = await apply(app, domainId);
    await app.inject({ method: "POST", url: `/competency/applications/${competency.id}/advance` });

    const res = await app.inject({
      method: "POST",
      url: `/competency/applications/${competency.id}/reject`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rejected");
  });

  it("409s advancing a rejected application (halted, cannot skip past rejection)", async () => {
    const domainId = await createDomain(app);
    const competency = await apply(app, domainId);
    await app.inject({ method: "POST", url: `/competency/applications/${competency.id}/reject` });

    const res = await app.inject({
      method: "POST",
      url: `/competency/applications/${competency.id}/advance`,
    });
    expect(res.statusCode).toBe(409);
  });

  it("409s rejecting an already-rejected application", async () => {
    const domainId = await createDomain(app);
    const competency = await apply(app, domainId);
    await app.inject({ method: "POST", url: `/competency/applications/${competency.id}/reject` });

    const res = await app.inject({
      method: "POST",
      url: `/competency/applications/${competency.id}/reject`,
    });
    expect(res.statusCode).toBe(409);
  });
});
