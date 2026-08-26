import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { ProblemStatus } from "../domain/types.js";

const problemInput = {
  citizen_id: "11111111-1111-1111-1111-111111111111",
  title: "Flooded underpass",
  description: "Underpass floods every heavy rain.",
  affected_area: "5th St underpass",
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

async function setStatus(
  app: FastifyInstance,
  id: string,
  status: ProblemStatus,
) {
  return app.inject({
    method: "POST",
    url: `/problems/${id}/status`,
    payload: { status },
  });
}

describe("POST /problems/:id/status", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it.each<[ProblemStatus, ProblemStatus]>([
    ["open", "proposing"],
    ["proposing", "closed"],
  ])("allows the legal transition %s -> %s", async (from, to) => {
    app = buildServer();
    const id = await submitProblem(app);
    if (from !== "open") {
      const setup = await setStatus(app, id, from);
      expect(setup.statusCode).toBe(200);
    }

    const res = await setStatus(app, id, to);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status: to });
  });

  it.each<[ProblemStatus, ProblemStatus]>([
    ["open", "closed"],
    ["open", "open"],
    ["proposing", "open"],
    ["proposing", "proposing"],
    ["closed", "open"],
    ["closed", "proposing"],
    ["closed", "closed"],
  ])("rejects the illegal transition %s -> %s with 409", async (from, to) => {
    app = buildServer();
    const id = await submitProblem(app);
    if (from !== "open") {
      const setup = await setStatus(app, id, "proposing");
      expect(setup.statusCode).toBe(200);
      if (from === "closed") {
        const setup2 = await setStatus(app, id, "closed");
        expect(setup2.statusCode).toBe(200);
      }
    }

    const res = await setStatus(app, id, to);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toHaveProperty("error");
  });

  it("returns 404 transitioning an unknown problem", async () => {
    app = buildServer();

    const res = await setStatus(
      app,
      "00000000-0000-0000-0000-000000000000",
      "proposing",
    );

    expect(res.statusCode).toBe(404);
  });

  it("rejects an unrecognized status value with 400", async () => {
    app = buildServer();
    const id = await submitProblem(app);

    const res = await app.inject({
      method: "POST",
      url: `/problems/${id}/status`,
      payload: { status: "archived" },
    });

    expect(res.statusCode).toBe(400);
  });
});
