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
});
