import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnGoService, spawnTsService, type SpawnedService } from "./harness.js";

describe("e2e harness smoke test", () => {
  let identity: SpawnedService;
  let auth: SpawnedService;

  beforeAll(async () => {
    identity = await spawnTsService("identity-service", 48491);
    auth = await spawnGoService("auth-service", 48492);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([identity?.stop(), auth?.stop()]);
  });

  it("boots a real identity-service process reachable over HTTP", async () => {
    const res = await fetch(`${identity.baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it("boots a real auth-service (Go) process reachable over HTTP", async () => {
    const res = await fetch(`${auth.baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });
});
