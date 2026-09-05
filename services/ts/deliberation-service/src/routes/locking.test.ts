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

  // ARCH-014 EC-26: a redundant second lock call on an already-locked
  // argument is a no-op 200, not an error.
  it("ARCH-014 EC-26: locking an already-locked argument again is a redundant no-op 200", async () => {
    app = buildServer();
    const created = await postArgument(app, { stance: "agreement" });
    const id = created.json().id;

    const first = await lockArgument(app, id);
    expect(first.statusCode).toBe(200);
    const second = await lockArgument(app, id);
    expect(second.statusCode).toBe(200);
    expect(second.json().locked).toBe(true);
  });

  // ARCH-014 EC-20: no actor/role check exists on this route today -- any
  // caller can lock any agreement-stance argument regardless of identity.
  // Documents the current (permissive) behavior explicitly so a future
  // authorization gate is caught by a changed test, not silently missed.
  it("ARCH-014 EC-20: locks succeed with no actor/role check of any kind", async () => {
    app = buildServer();
    const created = await postArgument(app, { stance: "agreement", citizen_id: "author-1" });
    const id = created.json().id;

    const res = await app.inject({
      method: "POST",
      url: `/deliberation/arguments/${id}/lock`,
      // No caller identity is sent or checked anywhere on this route.
    });
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
