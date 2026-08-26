import { describe, expect, it, afterAll } from "vitest";
import { buildServer } from "../server.js";

describe("domain routes", () => {
  const app = buildServer();

  afterAll(async () => {
    await app.close();
  });

  it("POST /competency/domains creates a domain", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/competency/domains",
      payload: { name: "transportation", description: "Roads, transit, and mobility policy" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      name: "transportation",
      description: "Roads, transit, and mobility policy",
    });
    expect(body.id).toBeTypeOf("string");
  });

  it("POST /competency/domains rejects a missing name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/competency/domains",
      payload: { description: "missing name" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTypeOf("string");
  });

  it("GET /competency/domains lists created domains", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/competency/domains",
      payload: { name: "healthcare", description: "Health policy" },
    });
    const createdId = created.json().id;

    const res = await app.inject({ method: "GET", url: "/competency/domains" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.some((d: { id: string }) => d.id === createdId)).toBe(true);
  });
});
