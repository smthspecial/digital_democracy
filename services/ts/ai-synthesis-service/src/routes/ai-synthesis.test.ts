import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { MANDATORY_LABEL } from "../domain/serialize.js";

function synthesizeBody() {
  return {
    proposal_id: "prop-1",
    arguments: [
      { content: "This bridge funding reduces traffic delay", stance: "agreement" },
      { content: "This bridge funding is wasteful and delay-prone", stance: "disagreement" },
    ],
    preferences: [{ description: "less traffic" }, { description: "Less Traffic" }],
  };
}

describe("POST /ai-synthesis/synthesize", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("runs the algorithm and returns a labeled output", async () => {
    app = buildServer();
    const res = await app.inject({ method: "POST", url: "/ai-synthesis/synthesize", payload: synthesizeBody() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.label).toBe(MANDATORY_LABEL);
    expect(body.model_provenance.model_name).toBe("rule-based-synthesis-v1");
    expect(body.shared_objectives).toEqual([{ description: "less traffic", count: 2 }]);
  });

  it("returns { disabled: true } and stores nothing while disabled", async () => {
    app = buildServer();
    await app.inject({ method: "POST", url: "/ai-synthesis/toggle", payload: { enabled: false } });
    const res = await app.inject({ method: "POST", url: "/ai-synthesis/synthesize", payload: synthesizeBody() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ disabled: true });

    const list = await app.inject({ method: "GET", url: "/ai-synthesis/proposals/prop-1/outputs" });
    expect(list.json()).toEqual([]);
  });

  it("returns 400 for a malformed body", async () => {
    app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/ai-synthesis/synthesize",
      payload: { proposal_id: "prop-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("rejects an unknown stance value", async () => {
    app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/ai-synthesis/synthesize",
      payload: {
        proposal_id: "prop-1",
        arguments: [{ content: "x", stance: "neutral" }],
        preferences: [],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /ai-synthesis/toggle", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("flips the enabled flag and echoes it back", async () => {
    app = buildServer();
    const res = await app.inject({ method: "POST", url: "/ai-synthesis/toggle", payload: { enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
  });
});

describe("GET /ai-synthesis/outputs/:id", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("returns 404 for an unknown id", async () => {
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/ai-synthesis/outputs/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
  });

  it("returns the stored output by id", async () => {
    app = buildServer();
    const created = await app.inject({ method: "POST", url: "/ai-synthesis/synthesize", payload: synthesizeBody() });
    const id = created.json().id as string;
    const res = await app.inject({ method: "GET", url: `/ai-synthesis/outputs/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    expect(res.json().label).toBe(MANDATORY_LABEL);
  });
});

describe("POST /ai-synthesis/outputs/:id/flag", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("accumulates reasons across repeated flag calls", async () => {
    app = buildServer();
    const created = await app.inject({ method: "POST", url: "/ai-synthesis/synthesize", payload: synthesizeBody() });
    const id = created.json().id as string;

    await app.inject({
      method: "POST",
      url: `/ai-synthesis/outputs/${id}/flag`,
      payload: { citizen_id: "citizen-a", reason: "seems biased" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/ai-synthesis/outputs/${id}/flag`,
      payload: { citizen_id: "citizen-b", reason: "misleading framing" },
    });

    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.flagged).toBe(true);
    expect(body.flag_reasons).toHaveLength(2);
  });

  it("returns 404 when flagging an unknown output", async () => {
    app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/ai-synthesis/outputs/does-not-exist/flag",
      payload: { citizen_id: "citizen-a", reason: "bad" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /ai-synthesis/proposals/:proposalId/outputs", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("lists all outputs for a proposal", async () => {
    app = buildServer();
    await app.inject({ method: "POST", url: "/ai-synthesis/synthesize", payload: synthesizeBody() });
    await app.inject({ method: "POST", url: "/ai-synthesis/synthesize", payload: synthesizeBody() });
    const res = await app.inject({ method: "GET", url: "/ai-synthesis/proposals/prop-1/outputs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });

  it("returns an empty array for a proposal with no outputs", async () => {
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/ai-synthesis/proposals/no-such-proposal/outputs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
