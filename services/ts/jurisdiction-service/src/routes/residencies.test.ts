import { describe, expect, it, afterAll } from "vitest";
import { buildServer } from "../server.js";

describe("residency routes", () => {
  const app = buildServer();

  afterAll(async () => {
    await app.close();
  });

  async function createJurisdiction() {
    const res = await app.inject({
      method: "POST",
      url: "/jurisdiction/jurisdictions",
      payload: { parent_id: null, name: "City", scope_level: "municipality", boundary_ref: "ref" },
    });
    return res.json();
  }

  it("POST /jurisdiction/residencies creates an active residency with no end_date", async () => {
    const jurisdiction = await createJurisdiction();
    const citizenId = "11111111-1111-1111-1111-111111111111";
    const res = await app.inject({
      method: "POST",
      url: "/jurisdiction/residencies",
      payload: { citizen_id: citizenId, jurisdiction_id: jurisdiction.id, start_date: "2020-01-01" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      citizen_id: citizenId,
      jurisdiction_id: jurisdiction.id,
      end_date: null,
      status: "active",
      verified: true,
    });
  });

  it("POST /jurisdiction/residencies rejects an unknown jurisdiction_id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jurisdiction/residencies",
      payload: {
        citizen_id: "11111111-1111-1111-1111-111111111111",
        jurisdiction_id: "00000000-0000-0000-0000-000000000000",
        start_date: "2020-01-01",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /jurisdiction/residencies rejects end_date before start_date", async () => {
    const jurisdiction = await createJurisdiction();
    const res = await app.inject({
      method: "POST",
      url: "/jurisdiction/residencies",
      payload: {
        citizen_id: "11111111-1111-1111-1111-111111111111",
        jurisdiction_id: jurisdiction.id,
        start_date: "2020-06-01",
        end_date: "2020-01-01",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /jurisdiction/residencies rejects an invalid date string", async () => {
    const jurisdiction = await createJurisdiction();
    const res = await app.inject({
      method: "POST",
      url: "/jurisdiction/residencies",
      payload: {
        citizen_id: "11111111-1111-1111-1111-111111111111",
        jurisdiction_id: jurisdiction.id,
        start_date: "not-a-date",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ARCH-011 EC-36: residency creation is a structural change that had no
  // audit emission at all until now.
  it("IT-011-EC-36: emits an audit event on residency creation", async () => {
    const events: string[] = [];
    const auditApp = buildServer({ auditEmitter: (eventType) => events.push(eventType) });
    const jurisdiction = (await auditApp.inject({
      method: "POST",
      url: "/jurisdiction/jurisdictions",
      payload: { parent_id: null, name: "Audit-City", scope_level: "municipality", boundary_ref: "ref" },
    })).json();

    const res = await auditApp.inject({
      method: "POST",
      url: "/jurisdiction/residencies",
      payload: {
        citizen_id: "11111111-1111-1111-1111-111111111111",
        jurisdiction_id: jurisdiction.id,
        start_date: "2020-01-01",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(events).toEqual(["jurisdiction.created", "residency.created"]);
    await auditApp.close();
  });

  describe("GET /jurisdiction/residency/verify", () => {
    it("is true at an instant within the residency period", async () => {
      const jurisdiction = await createJurisdiction();
      const citizenId = "22222222-2222-2222-2222-222222222222";
      await app.inject({
        method: "POST",
        url: "/jurisdiction/residencies",
        payload: {
          citizen_id: citizenId,
          jurisdiction_id: jurisdiction.id,
          start_date: "2020-01-01",
          end_date: "2020-12-31",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/jurisdiction/residency/verify?citizen_id=${citizenId}&jurisdiction_id=${jurisdiction.id}&at=2020-06-15`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ verified: true });
    });

    it("is false for an instant after end_date", async () => {
      const jurisdiction = await createJurisdiction();
      const citizenId = "33333333-3333-3333-3333-333333333333";
      await app.inject({
        method: "POST",
        url: "/jurisdiction/residencies",
        payload: {
          citizen_id: citizenId,
          jurisdiction_id: jurisdiction.id,
          start_date: "2020-01-01",
          end_date: "2020-12-31",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/jurisdiction/residency/verify?citizen_id=${citizenId}&jurisdiction_id=${jurisdiction.id}&at=2021-01-15`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ verified: false });
    });

    it("is false when the citizen has no residency there at all", async () => {
      const jurisdiction = await createJurisdiction();
      const res = await app.inject({
        method: "GET",
        url: `/jurisdiction/residency/verify?citizen_id=44444444-4444-4444-4444-444444444444&jurisdiction_id=${jurisdiction.id}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ verified: false });
    });
  });
});
