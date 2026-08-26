import { describe, expect, it, afterAll } from "vitest";
import { buildServer } from "../server.js";

describe("GET /jurisdiction/eligibility", () => {
  const app = buildServer();
  const citizenId = "11111111-1111-1111-1111-111111111111";

  afterAll(async () => {
    await app.close();
  });

  async function createJurisdiction(parentId: string | null, name: string, scopeLevel: string) {
    const res = await app.inject({
      method: "POST",
      url: "/jurisdiction/jurisdictions",
      payload: { parent_id: parentId, name, scope_level: scopeLevel, boundary_ref: `ref-${name}` },
    });
    return res.json();
  }

  async function addMembership(jurisdictionId: string) {
    await app.inject({
      method: "POST",
      url: "/jurisdiction/memberships",
      payload: { citizen_id: citizenId, jurisdiction_id: jurisdictionId },
    });
  }

  async function addResidency(jurisdictionId: string, startDate: string) {
    await app.inject({
      method: "POST",
      url: "/jurisdiction/residencies",
      payload: { citizen_id: citizenId, jurisdiction_id: jurisdictionId, start_date: startDate },
    });
  }

  function daysAgo(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }

  async function checkEligibility(scopeJurisdictionId: string, minResidencyDays?: number) {
    const query = new URLSearchParams({ citizen_id: citizenId, scope_jurisdiction_id: scopeJurisdictionId });
    if (minResidencyDays !== undefined) query.set("min_residency_days", String(minResidencyDays));
    return app.inject({ method: "GET", url: `/jurisdiction/eligibility?${query.toString()}` });
  }

  it("is eligible when membership and sufficient residency both hold at the scope jurisdiction", async () => {
    const city = await createJurisdiction(null, "City-eligible", "city");
    await addMembership(city.id);
    await addResidency(city.id, daysAgo(60));

    const res = await checkEligibility(city.id, 30);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ eligible: true, reasons: [] });
  });

  it("is ineligible with a reason when there is no membership at all", async () => {
    const city = await createJurisdiction(null, "City-no-membership", "city");

    const res = await checkEligibility(city.id, 30);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      eligible: false,
      reasons: ["no membership in scope jurisdiction or its descendants"],
    });
  });

  it("is ineligible with a reason when membership exists but there is no current residency", async () => {
    const city = await createJurisdiction(null, "City-no-residency", "city");
    await addMembership(city.id);

    const res = await checkEligibility(city.id, 30);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      eligible: false,
      reasons: ["no current residency in a member jurisdiction"],
    });
  });

  it("is ineligible with a reason when residency is shorter than the minimum period", async () => {
    const city = await createJurisdiction(null, "City-short-residency", "city");
    await addMembership(city.id);
    await addResidency(city.id, daysAgo(5));

    const res = await checkEligibility(city.id, 30);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      eligible: false,
      reasons: ["residency duration below minimum required days"],
    });
  });

  it("defaults min_residency_days to 30 when the query param is omitted", async () => {
    const city = await createJurisdiction(null, "City-default-min", "city");
    await addMembership(city.id);
    await addResidency(city.id, daysAgo(10));

    const res = await checkEligibility(city.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().eligible).toBe(false);
  });

  it("a membership and residency in a descendant jurisdiction satisfies an ancestor scope check", async () => {
    const region = await createJurisdiction(null, "Region-desc", "region");
    const city = await createJurisdiction(region.id, "City-desc", "city");
    const neighborhood = await createJurisdiction(city.id, "Neighborhood-desc", "neighborhood");
    await addMembership(neighborhood.id);
    await addResidency(neighborhood.id, daysAgo(60));

    const res = await checkEligibility(region.id, 30);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ eligible: true, reasons: [] });
  });

  it("membership in one branch and residency in an unrelated branch does not satisfy eligibility", async () => {
    const region = await createJurisdiction(null, "Region-mixed", "region");
    const cityA = await createJurisdiction(region.id, "City-A", "city");
    const cityB = await createJurisdiction(region.id, "City-B", "city");
    await addMembership(cityA.id);
    await addResidency(cityB.id, daysAgo(60));

    const res = await checkEligibility(region.id, 30);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      eligible: false,
      reasons: ["no current residency in a member jurisdiction"],
    });
  });

  it("400s when scope_jurisdiction_id does not exist", async () => {
    const res = await checkEligibility("00000000-0000-0000-0000-000000000000", 30);
    expect(res.statusCode).toBe(400);
  });
});
