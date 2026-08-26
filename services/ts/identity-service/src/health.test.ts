import { describe, expect, it, afterAll } from "vitest";
import { buildTestServer } from "./test-utils.js";

describe("health routes", () => {
  const { app } = buildTestServer();

  afterAll(async () => {
    await app.close();
  });

  it("GET /healthz returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz returns ready", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });
});
