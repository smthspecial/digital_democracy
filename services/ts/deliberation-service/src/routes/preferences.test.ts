import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";

async function postPreference(app: FastifyInstance, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/deliberation/preferences",
    payload: {
      problem_id: "problem-1",
      citizen_id: "citizen-1",
      description: "Safer bike lanes on Main St",
      ...overrides,
    },
  });
}

describe("POST /deliberation/preferences", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("creates a preference and returns 201", async () => {
    app = buildServer();
    const res = await postPreference(app);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTypeOf("string");
    expect(body.problem_id).toBe("problem-1");
    expect(body.citizen_id).toBe("citizen-1");
    expect(body.description).toBe("Safer bike lanes on Main St");
    expect(body.created_at).toBeTypeOf("string");
  });

  it("rejects a submission missing description with 400", async () => {
    app = buildServer();
    const res = await postPreference(app, { description: undefined });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /deliberation/problems/:problemId/preferences", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("lists preferences for a problem sorted by created_at", async () => {
    app = buildServer();
    await postPreference(app, { problem_id: "problem-A", description: "first" });
    await postPreference(app, { problem_id: "problem-A", description: "second" });
    await postPreference(app, { problem_id: "problem-B", description: "other problem" });

    const res = await app.inject({ method: "GET", url: "/deliberation/problems/problem-A/preferences" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body[0].description).toBe("first");
    expect(body[1].description).toBe("second");
  });

  it("returns an empty list for a problem with no preferences", async () => {
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/deliberation/problems/none/preferences" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
