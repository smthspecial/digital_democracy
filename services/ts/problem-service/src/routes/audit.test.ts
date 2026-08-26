import { describe, expect, it, vi, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { AuditEmitter } from "../collaborators.js";

const problemInput = {
  citizen_id: "11111111-1111-1111-1111-111111111111",
  title: "Overgrown park",
  description: "Weeds overtaking the community park.",
  affected_area: "Riverside Park",
  candidate_scope: "city",
};

describe("audit emission", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("emits an audit event on problem creation", async () => {
    const emit = vi.fn();
    const audit: AuditEmitter = { emit };
    app = buildServer({ audit });

    const res = await app.inject({
      method: "POST",
      url: "/problems",
      payload: problemInput,
    });

    expect(res.statusCode).toBe(201);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "problem.created",
      expect.objectContaining({ problemId: res.json().id }),
    );
  });

  it("emits an audit event on every status change but not on illegal transitions", async () => {
    const emit = vi.fn();
    app = buildServer({ audit: { emit } });

    const created = await app.inject({
      method: "POST",
      url: "/problems",
      payload: problemInput,
    });
    const id = created.json().id as string;
    emit.mockClear();

    const legal = await app.inject({
      method: "POST",
      url: `/problems/${id}/status`,
      payload: { status: "proposing" },
    });
    expect(legal.statusCode).toBe(200);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "problem.status_changed",
      expect.objectContaining({ problemId: id, from: "open", to: "proposing" }),
    );

    emit.mockClear();
    const illegal = await app.inject({
      method: "POST",
      url: `/problems/${id}/status`,
      payload: { status: "open" },
    });
    expect(illegal.statusCode).toBe(409);
    expect(emit).not.toHaveBeenCalled();
  });
});
