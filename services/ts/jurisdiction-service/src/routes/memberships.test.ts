import { describe, expect, it, afterAll } from "vitest";
import { buildServer } from "../server.js";

describe("membership routes", () => {
  const app = buildServer();

  afterAll(async () => {
    await app.close();
  });

  async function createJurisdiction(name = "City") {
    const res = await app.inject({
      method: "POST",
      url: "/jurisdiction/jurisdictions",
      payload: { parent_id: null, name, scope_level: "municipality", boundary_ref: "ref" },
    });
    return res.json();
  }

  it("POST /jurisdiction/memberships creates a membership", async () => {
    const jurisdiction = await createJurisdiction();
    const citizenId = "11111111-1111-1111-1111-111111111111";
    const res = await app.inject({
      method: "POST",
      url: "/jurisdiction/memberships",
      payload: { citizen_id: citizenId, jurisdiction_id: jurisdiction.id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ citizen_id: citizenId, jurisdiction_id: jurisdiction.id });
  });

  it("POST /jurisdiction/memberships rejects an unknown jurisdiction_id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jurisdiction/memberships",
      payload: {
        citizen_id: "11111111-1111-1111-1111-111111111111",
        jurisdiction_id: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /jurisdiction/memberships rejects a duplicate for the same citizen and jurisdiction", async () => {
    const jurisdiction = await createJurisdiction();
    const citizenId = "22222222-2222-2222-2222-222222222222";
    await app.inject({
      method: "POST",
      url: "/jurisdiction/memberships",
      payload: { citizen_id: citizenId, jurisdiction_id: jurisdiction.id },
    });
    const res = await app.inject({
      method: "POST",
      url: "/jurisdiction/memberships",
      payload: { citizen_id: citizenId, jurisdiction_id: jurisdiction.id },
    });
    expect(res.statusCode).toBe(409);
  });

  it("allows the same citizen to hold simultaneous memberships in nested jurisdictions", async () => {
    const nation = await createJurisdiction("Nation");
    const city = (
      await app.inject({
        method: "POST",
        url: "/jurisdiction/jurisdictions",
        payload: { parent_id: nation.id, name: "Nested City", scope_level: "municipality", boundary_ref: "ref" },
      })
    ).json();
    const citizenId = "33333333-3333-3333-3333-333333333333";

    const nationRes = await app.inject({
      method: "POST",
      url: "/jurisdiction/memberships",
      payload: { citizen_id: citizenId, jurisdiction_id: nation.id },
    });
    const cityRes = await app.inject({
      method: "POST",
      url: "/jurisdiction/memberships",
      payload: { citizen_id: citizenId, jurisdiction_id: city.id },
    });
    expect(nationRes.statusCode).toBe(201);
    expect(cityRes.statusCode).toBe(201);

    const listRes = await app.inject({ method: "GET", url: `/jurisdiction/memberships?citizen_id=${citizenId}` });
    expect(listRes.statusCode).toBe(200);
    const jurisdictionIds = listRes.json().map((m: { jurisdiction_id: string }) => m.jurisdiction_id);
    expect(jurisdictionIds.sort()).toEqual([nation.id, city.id].sort());
  });

  it("GET /jurisdiction/memberships returns an empty list for a citizen with none", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/jurisdiction/memberships?citizen_id=99999999-9999-9999-9999-999999999999",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
