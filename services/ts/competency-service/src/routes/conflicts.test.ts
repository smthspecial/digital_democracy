import { describe, expect, it, afterAll, vi } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { ExclusionEnforcer, ReputationEmitter } from "../integrations.js";

describe("conflict-of-interest routes", () => {
  const store = createStore();
  const exclusionEnforcer: ExclusionEnforcer = { exclude: vi.fn() };
  const reputationEmitter: ReputationEmitter = { emit: vi.fn() };
  const app = buildServer({ store, exclusionEnforcer, reputationEmitter });

  afterAll(async () => {
    await app.close();
  });

  it("POST /competency/conflicts records the disclosure and invokes the exclusion enforcer with the right args", async () => {
    const domainRes = await app.inject({
      method: "POST",
      url: "/competency/domains",
      payload: { name: "energy", description: "Energy policy" },
    });
    const domainId = domainRes.json().id;

    const res = await app.inject({
      method: "POST",
      url: "/competency/conflicts",
      payload: { citizen_id: "citizen-3", domain_id: domainId, description: "Owns shares in a utility" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      citizen_id: "citizen-3",
      domain_id: domainId,
      description: "Owns shares in a utility",
    });
    expect(body.disclosed_at).toBeTypeOf("string");

    expect(exclusionEnforcer.exclude).toHaveBeenCalledWith("citizen-3", domainId);
    expect(reputationEmitter.emit).toHaveBeenCalledWith("citizen-3", "disclosure", 5, body.id);
  });

  it("404s declaring a conflict against an unknown domain", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/competency/conflicts",
      payload: { citizen_id: "citizen-3", domain_id: "nonexistent", description: "n/a" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ARCH-010 EC-8: the domain-agnostic read side other services' COIChecker
  // seams consume (e.g. governance-role-service's, for actions with no
  // domain of their own to scope a check against).
  it("GET /competency/conflicts?citizen_id=... reports has_conflict=true once a conflict is declared", async () => {
    const domainRes = await app.inject({
      method: "POST",
      url: "/competency/domains",
      payload: { name: "transport", description: "Transport policy" },
    });
    const domainId = domainRes.json().id;

    await app.inject({
      method: "POST",
      url: "/competency/conflicts",
      payload: { citizen_id: "citizen-9", domain_id: domainId, description: "Consults for a transit operator" },
    });

    const res = await app.inject({ method: "GET", url: "/competency/conflicts?citizen_id=citizen-9" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ citizen_id: "citizen-9", has_conflict: true, domain_ids: [domainId] });
  });

  it("GET /competency/conflicts?citizen_id=... reports has_conflict=false for a citizen with no declared conflicts", async () => {
    const res = await app.inject({ method: "GET", url: "/competency/conflicts?citizen_id=citizen-with-none" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ citizen_id: "citizen-with-none", has_conflict: false, domain_ids: [] });
  });

  it("GET /competency/conflicts without citizen_id returns 400", async () => {
    const res = await app.inject({ method: "GET", url: "/competency/conflicts" });
    expect(res.statusCode).toBe(400);
  });
});
