import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";

const validSubmission = {
  citizen_id: "11111111-1111-1111-1111-111111111111",
  title: "Potholes on Main St",
  description: "Several deep potholes causing damage.",
  affected_area: "Main St corridor",
  candidate_scope: "city",
};

describe("POST /problems", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("submits a problem and makes it publicly readable immediately", async () => {
    app = buildServer();

    const submitRes = await app.inject({
      method: "POST",
      url: "/problems",
      payload: validSubmission,
    });

    expect(submitRes.statusCode).toBe(201);
    const created = submitRes.json();
    expect(created).toMatchObject({
      citizen_id: validSubmission.citizen_id,
      title: validSubmission.title,
      description: validSubmission.description,
      affected_area: validSubmission.affected_area,
      candidate_scope: validSubmission.candidate_scope,
      status: "open",
    });
    expect(created.id).toEqual(expect.any(String));
    expect(created.created_at).toEqual(expect.any(String));

    const readRes = await app.inject({
      method: "GET",
      url: `/problems/${created.id}`,
    });
    expect(readRes.statusCode).toBe(200);
    expect(readRes.json()).toEqual(created);

    const listRes = await app.inject({ method: "GET", url: "/problems" });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toEqual([created]);
  });

  it("rejects a submission missing required fields with 400", async () => {
    app = buildServer();

    const res = await app.inject({
      method: "POST",
      url: "/problems",
      payload: { title: "Missing citizen id" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });
});

describe("GET /problems/:id", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("returns 404 for an unknown problem", async () => {
    app = buildServer();

    const res = await app.inject({
      method: "GET",
      url: "/problems/00000000-0000-0000-0000-000000000000",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
  });

  // ARCH-012 EC-27: a problem with zero endorsements and zero linked
  // proposals is still publicly visible, not an error -- empty-collection
  // boundary. (problem-service's own response carries no embedded
  // support/proposal list to assert empty; the boundary this proves is
  // that "no endorsements yet" is a normal, readable state, not a 404 or
  // 500.)
  it("IT-012-EC-27: a freshly submitted problem with zero endorsements is publicly visible", async () => {
    app = buildServer();
    const created = (
      await app.inject({ method: "POST", url: "/problems", payload: validSubmission })
    ).json();

    const read = await app.inject({ method: "GET", url: `/problems/${created.id}` });
    expect(read.statusCode).toBe(200);
    expect(read.json().status).toBe("open");

    const list = await app.inject({ method: "GET", url: "/problems" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toContainEqual(created);
  });
});
