import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";

async function postArgument(app: FastifyInstance, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/deliberation/arguments",
    payload: {
      proposal_id: "prop-1",
      citizen_id: "citizen-1",
      parent_id: null,
      content: "Impact studies show this reduces emissions.",
      evidence_ref: "https://example.org/study-1",
      stance: "agreement",
      ...overrides,
    },
  });
}

describe("POST /deliberation/arguments", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("creates an argument and returns 201", async () => {
    app = buildServer();
    const res = await postArgument(app);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTypeOf("string");
    expect(body.proposal_id).toBe("prop-1");
    expect(body.evidence_ref).toBe("https://example.org/study-1");
    expect(body.stance).toBe("agreement");
    expect(body.locked).toBe(false);
    expect(body.created_at).toBeTypeOf("string");
  });

  it("rejects a submission missing evidence_ref with 400", async () => {
    app = buildServer();
    const res = await postArgument(app, { evidence_ref: undefined });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTypeOf("string");
  });

  it("rejects a submission with an empty evidence_ref with 400", async () => {
    app = buildServer();
    const res = await postArgument(app, { evidence_ref: "" });
    expect(res.statusCode).toBe(400);
  });

  it.each(["agreement", "disagreement"])("accepts stance %s", async (stance) => {
    app = buildServer();
    const res = await postArgument(app, { stance });
    expect(res.statusCode).toBe(201);
    expect(res.json().stance).toBe(stance);
  });

  it("rejects an invalid stance with 400", async () => {
    app = buildServer();
    const res = await postArgument(app, { stance: "neutral" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a reply whose parent_id does not exist with 404", async () => {
    app = buildServer();
    const res = await postArgument(app, { parent_id: "does-not-exist" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /deliberation/proposals/:proposalId/arguments", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("lists arguments for a proposal sorted by created_at, flat with parent_id", async () => {
    app = buildServer();
    const first = await postArgument(app, { proposal_id: "prop-A", content: "first" });
    const firstId = first.json().id;
    await postArgument(app, { proposal_id: "prop-A", parent_id: firstId, content: "reply" });
    await postArgument(app, { proposal_id: "prop-B", content: "other proposal" });

    const res = await app.inject({ method: "GET", url: "/deliberation/proposals/prop-A/arguments" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body[0].content).toBe("first");
    expect(body[1].content).toBe("reply");
    expect(body[1].parent_id).toBe(firstId);
  });

  it("returns an empty list for a proposal with no arguments", async () => {
    app = buildServer();
    const res = await app.inject({ method: "GET", url: "/deliberation/proposals/none/arguments" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
