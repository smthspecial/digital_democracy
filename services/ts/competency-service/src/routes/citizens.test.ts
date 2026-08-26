import { describe, expect, it, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";

describe("citizen competency status route", () => {
  const store = createStore();
  const app = buildServer({ store });

  afterAll(async () => {
    await app.close();
  });

  it("reports false for a citizen with no competency in the domain", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/competency/citizens/citizen-1/domains/domain-1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it("reports true once the pipeline completes, false in an unrelated domain (no cross-domain inference)", async () => {
    const domainRes = await app.inject({
      method: "POST",
      url: "/competency/domains",
      payload: { name: "healthcare", description: "Health policy" },
    });
    const domainId = domainRes.json().id;

    const otherDomainRes = await app.inject({
      method: "POST",
      url: "/competency/domains",
      payload: { name: "energy", description: "Energy policy" },
    });
    const otherDomainId = otherDomainRes.json().id;

    const appRes = await app.inject({
      method: "POST",
      url: "/competency/applications",
      payload: { citizen_id: "citizen-2", domain_id: domainId },
    });
    const competencyId = appRes.json().id;
    for (let i = 0; i < 4; i++) {
      await app.inject({ method: "POST", url: `/competency/applications/${competencyId}/advance` });
    }

    const activeRes = await app.inject({
      method: "GET",
      url: `/competency/citizens/citizen-2/domains/${domainId}`,
    });
    expect(activeRes.json()).toEqual({ active: true });

    const otherDomainActiveRes = await app.inject({
      method: "GET",
      url: `/competency/citizens/citizen-2/domains/${otherDomainId}`,
    });
    expect(otherDomainActiveRes.json()).toEqual({ active: false });
  });
});
