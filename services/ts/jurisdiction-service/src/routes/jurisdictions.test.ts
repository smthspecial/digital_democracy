import { describe, expect, it, afterAll } from "vitest";
import { buildServer } from "../server.js";

describe("jurisdiction routes", () => {
  const app = buildServer();

  afterAll(async () => {
    await app.close();
  });

  async function createJurisdiction(body: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/jurisdiction/jurisdictions", payload: body });
  }

  it("POST /jurisdiction/jurisdictions creates a root jurisdiction", async () => {
    const res = await createJurisdiction({
      parent_id: null,
      name: "Republic",
      scope_level: "national",
      boundary_ref: "https://boundaries.example/republic",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      parent_id: null,
      name: "Republic",
      scope_level: "national",
      boundary_ref: "https://boundaries.example/republic",
      status: "active",
    });
    expect(typeof body.id).toBe("string");
  });

  it("POST /jurisdiction/jurisdictions rejects an unknown parent_id", async () => {
    const res = await createJurisdiction({
      parent_id: "00000000-0000-0000-0000-000000000000",
      name: "Ghost city",
      scope_level: "city",
      boundary_ref: "ref",
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /jurisdiction/jurisdictions rejects an invalid scope_level", async () => {
    const res = await createJurisdiction({
      parent_id: null,
      name: "Bad",
      scope_level: "planet",
      boundary_ref: "ref",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /jurisdiction/jurisdictions/:id/tree builds a nested tree across multiple levels", async () => {
    const nation = (await createJurisdiction({
      parent_id: null,
      name: "Nation",
      scope_level: "national",
      boundary_ref: "ref-nation",
    })).json();
    const region = (await createJurisdiction({
      parent_id: nation.id,
      name: "Region",
      scope_level: "region",
      boundary_ref: "ref-region",
    })).json();
    const city = (await createJurisdiction({
      parent_id: region.id,
      name: "City",
      scope_level: "city",
      boundary_ref: "ref-city",
    })).json();
    await createJurisdiction({
      parent_id: city.id,
      name: "Neighborhood",
      scope_level: "neighborhood",
      boundary_ref: "ref-neighborhood",
    });

    const res = await app.inject({ method: "GET", url: `/jurisdiction/jurisdictions/${nation.id}/tree` });
    expect(res.statusCode).toBe(200);
    const tree = res.json();
    expect(tree.id).toBe(nation.id);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].id).toBe(region.id);
    expect(tree.children[0].children[0].id).toBe(city.id);
    expect(tree.children[0].children[0].children[0].name).toBe("Neighborhood");
    expect(tree.children[0].children[0].children[0].children).toEqual([]);
  });

  it("GET /jurisdiction/jurisdictions/:id/tree 404s for an unknown id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/jurisdiction/jurisdictions/00000000-0000-0000-0000-000000000000/tree",
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /jurisdiction/jurisdictions/:id/scope-level is blocked without approval", async () => {
    const approvalGateApp = buildServer({ approvalGate: () => false });
    const jurisdiction = (await approvalGateApp.inject({
      method: "POST",
      url: "/jurisdiction/jurisdictions",
      payload: { parent_id: null, name: "X", scope_level: "city", boundary_ref: "ref" },
    })).json();

    const res = await approvalGateApp.inject({
      method: "POST",
      url: `/jurisdiction/jurisdictions/${jurisdiction.id}/scope-level`,
      payload: { scope_level: "region" },
    });
    expect(res.statusCode).toBe(403);
    await approvalGateApp.close();
  });

  it("POST /jurisdiction/jurisdictions/:id/scope-level succeeds with approval", async () => {
    const approvalGateApp = buildServer({ approvalGate: () => true });
    const jurisdiction = (await approvalGateApp.inject({
      method: "POST",
      url: "/jurisdiction/jurisdictions",
      payload: { parent_id: null, name: "X", scope_level: "city", boundary_ref: "ref" },
    })).json();

    const res = await approvalGateApp.inject({
      method: "POST",
      url: `/jurisdiction/jurisdictions/${jurisdiction.id}/scope-level`,
      payload: { scope_level: "region" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().scope_level).toBe("region");
    await approvalGateApp.close();
  });

  it("POST /jurisdiction/jurisdictions/:id/scope-level 404s for an unknown id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jurisdiction/jurisdictions/00000000-0000-0000-0000-000000000000/scope-level",
      payload: { scope_level: "region" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("emits an audit event on jurisdiction creation and scope-level change", async () => {
    const events: string[] = [];
    const auditApp = buildServer({ auditEmitter: (eventType) => events.push(eventType) });
    const jurisdiction = (await auditApp.inject({
      method: "POST",
      url: "/jurisdiction/jurisdictions",
      payload: { parent_id: null, name: "X", scope_level: "city", boundary_ref: "ref" },
    })).json();
    await auditApp.inject({
      method: "POST",
      url: `/jurisdiction/jurisdictions/${jurisdiction.id}/scope-level`,
      payload: { scope_level: "region" },
    });
    expect(events).toEqual(["jurisdiction.created", "jurisdiction.scope_level_changed"]);
    await auditApp.close();
  });
});
