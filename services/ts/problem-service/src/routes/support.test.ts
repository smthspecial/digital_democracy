import { describe, expect, it, vi, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { ThresholdChecker } from "../collaborators.js";

const problemInput = {
  citizen_id: "11111111-1111-1111-1111-111111111111",
  title: "Broken streetlights",
  description: "Streetlights out along Elm Ave.",
  affected_area: "Elm Ave",
  candidate_scope: "city",
};

async function submitProblem(app: FastifyInstance) {
  const res = await app.inject({
    method: "POST",
    url: "/problems",
    payload: problemInput,
  });
  return res.json().id as string;
}

describe("POST /problems/:id/support", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("returns 404 endorsing an unknown problem", async () => {
    app = buildServer();

    const res = await app.inject({
      method: "POST",
      url: "/problems/00000000-0000-0000-0000-000000000000/support",
      payload: { citizen_id: "22222222-2222-2222-2222-222222222222" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("rejects a duplicate endorsement from the same citizen with 409", async () => {
    app = buildServer();
    const problemId = await submitProblem(app);
    const citizenId = "22222222-2222-2222-2222-222222222222";

    const first = await app.inject({
      method: "POST",
      url: `/problems/${problemId}/support`,
      payload: { citizen_id: citizenId },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ support_count: 1 });

    const second = await app.inject({
      method: "POST",
      url: `/problems/${problemId}/support`,
      payload: { citizen_id: citizenId },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toHaveProperty("error");
  });

  it("invokes the ThresholdChecker exactly once per successful endorsement with the running count", async () => {
    const checkThreshold = vi.fn();
    const thresholdChecker: ThresholdChecker = { checkThreshold };
    app = buildServer({ thresholdChecker });
    const problemId = await submitProblem(app);

    const firstRes = await app.inject({
      method: "POST",
      url: `/problems/${problemId}/support`,
      payload: { citizen_id: "22222222-2222-2222-2222-222222222222" },
    });
    expect(firstRes.statusCode).toBe(200);
    expect(checkThreshold).toHaveBeenCalledTimes(1);
    expect(checkThreshold).toHaveBeenLastCalledWith(problemId, 1);

    const secondRes = await app.inject({
      method: "POST",
      url: `/problems/${problemId}/support`,
      payload: { citizen_id: "33333333-3333-3333-3333-333333333333" },
    });
    expect(secondRes.statusCode).toBe(200);
    expect(checkThreshold).toHaveBeenCalledTimes(2);
    expect(checkThreshold).toHaveBeenLastCalledWith(problemId, 2);
  });

  it("does not invoke the ThresholdChecker on a rejected duplicate endorsement", async () => {
    const checkThreshold = vi.fn();
    app = buildServer({ thresholdChecker: { checkThreshold } });
    const problemId = await submitProblem(app);
    const citizenId = "22222222-2222-2222-2222-222222222222";

    await app.inject({
      method: "POST",
      url: `/problems/${problemId}/support`,
      payload: { citizen_id: citizenId },
    });
    checkThreshold.mockClear();

    const dup = await app.inject({
      method: "POST",
      url: `/problems/${problemId}/support`,
      payload: { citizen_id: citizenId },
    });
    expect(dup.statusCode).toBe(409);
    expect(checkThreshold).not.toHaveBeenCalled();
  });
});
