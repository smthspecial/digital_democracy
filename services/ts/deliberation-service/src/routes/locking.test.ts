import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";

async function postArgument(app: FastifyInstance, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/deliberation/arguments",
    payload: {
      proposal_id: "prop-1",
      citizen_id: "citizen-1",
      parent_id: null,
      content: "body",
      evidence_ref: "https://example.org/evidence",
      stance: "agreement",
      ...overrides,
    },
  });
  return res;
}

function lockArgument(app: FastifyInstance, id: string) {
  return app.inject({ method: "POST", url: `/deliberation/arguments/${id}/lock` });
}

describe("POST /deliberation/arguments/:id/lock", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("locks an agreement-stance argument", async () => {
    app = buildServer();
    const created = await postArgument(app, { stance: "agreement" });
    const id = created.json().id;

    const res = await lockArgument(app, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().locked).toBe(true);
  });

  it("rejects locking a disagreement-stance argument with 400", async () => {
    app = buildServer();
    const created = await postArgument(app, { stance: "disagreement" });
    const id = created.json().id;

    const res = await lockArgument(app, id);
    expect(res.statusCode).toBe(400);
    expect(res.json().locked).toBeUndefined();
  });

  it("returns 404 when locking a non-existent argument", async () => {
    app = buildServer();
    const res = await lockArgument(app, "no-such-id");
    expect(res.statusCode).toBe(404);
  });

  it("rejects a reply anywhere under a locked agreement branch with 409", async () => {
    app = buildServer();
    const root = await postArgument(app, { stance: "agreement", content: "root" });
    const rootId = root.json().id;
    const child = await postArgument(app, { parent_id: rootId, content: "child" });
    const childId = child.json().id;

    await lockArgument(app, rootId);

    const directReply = await postArgument(app, { parent_id: rootId, content: "direct reply" });
    expect(directReply.statusCode).toBe(409);

    const grandchildReply = await postArgument(app, { parent_id: childId, content: "grandchild reply" });
    expect(grandchildReply.statusCode).toBe(409);
  });

  it("accepts a reply under an unlocked branch", async () => {
    app = buildServer();
    const root = await postArgument(app, { stance: "agreement", content: "root" });
    const rootId = root.json().id;

    const reply = await postArgument(app, { parent_id: rootId, content: "reply" });
    expect(reply.statusCode).toBe(201);
  });

  it("does not lock a sibling branch when a different branch is locked", async () => {
    app = buildServer();
    const lockedRoot = await postArgument(app, { stance: "agreement", content: "locked root" });
    const openRoot = await postArgument(app, { stance: "agreement", content: "open root" });
    await lockArgument(app, lockedRoot.json().id);

    const reply = await postArgument(app, { parent_id: openRoot.json().id, content: "reply on open branch" });
    expect(reply.statusCode).toBe(201);
  });
});
