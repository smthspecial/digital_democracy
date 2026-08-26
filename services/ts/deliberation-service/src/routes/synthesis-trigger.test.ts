import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import type { SynthesisTrigger } from "../collaborators.js";

function postArgument(app: FastifyInstance, proposalId: string) {
  return app.inject({
    method: "POST",
    url: "/deliberation/arguments",
    payload: {
      proposal_id: proposalId,
      citizen_id: "citizen-1",
      parent_id: null,
      content: "body",
      evidence_ref: "https://example.org/evidence",
      stance: "agreement",
    },
  });
}

function postPreference(app: FastifyInstance, problemId: string) {
  return app.inject({
    method: "POST",
    url: "/deliberation/preferences",
    payload: {
      problem_id: problemId,
      citizen_id: "citizen-1",
      description: "desired outcome",
    },
  });
}

describe("DP-037 synthesis threshold trigger", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("does not fire below the threshold, fires exactly once at the threshold, and not again on the next write", async () => {
    const calls: string[] = [];
    const synthesisTrigger: SynthesisTrigger = { trigger: (subjectId) => calls.push(subjectId) };
    app = buildServer({ synthesisThreshold: 3, synthesisTrigger });

    await postArgument(app, "prop-1");
    expect(calls).toHaveLength(0);
    await postArgument(app, "prop-1");
    expect(calls).toHaveLength(0);

    await postArgument(app, "prop-1");
    expect(calls).toEqual(["prop-1"]);

    await postArgument(app, "prop-1");
    expect(calls).toEqual(["prop-1"]);
  });

  it("fires again once the next threshold multiple is crossed", async () => {
    const calls: string[] = [];
    const synthesisTrigger: SynthesisTrigger = { trigger: (subjectId) => calls.push(subjectId) };
    app = buildServer({ synthesisThreshold: 3, synthesisTrigger });

    for (let i = 0; i < 5; i++) {
      await postArgument(app, "prop-1");
    }
    expect(calls).toEqual(["prop-1"]);

    await postArgument(app, "prop-1");
    expect(calls).toEqual(["prop-1", "prop-1"]);
  });

  it("tracks arguments per proposal independently", async () => {
    const calls: string[] = [];
    const synthesisTrigger: SynthesisTrigger = { trigger: (subjectId) => calls.push(subjectId) };
    app = buildServer({ synthesisThreshold: 3, synthesisTrigger });

    await postArgument(app, "prop-1");
    await postArgument(app, "prop-1");
    await postArgument(app, "prop-2");
    expect(calls).toHaveLength(0);

    await postArgument(app, "prop-2");
    await postArgument(app, "prop-2");
    expect(calls).toEqual(["prop-2"]);
  });

  it("fires for preferences keyed by problem_id, independently of arguments", async () => {
    const calls: string[] = [];
    const synthesisTrigger: SynthesisTrigger = { trigger: (subjectId) => calls.push(subjectId) };
    app = buildServer({ synthesisThreshold: 3, synthesisTrigger });

    await postPreference(app, "problem-1");
    await postPreference(app, "problem-1");
    expect(calls).toHaveLength(0);

    await postPreference(app, "problem-1");
    expect(calls).toEqual(["problem-1"]);
  });

  it("defaults to a threshold of 5 with a no-op trigger when nothing is injected", async () => {
    app = buildServer();
    for (let i = 0; i < 6; i++) {
      const res = await postArgument(app, "prop-1");
      expect(res.statusCode).toBe(201);
    }
  });
});
