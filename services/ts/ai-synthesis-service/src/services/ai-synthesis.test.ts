import { describe, expect, it } from "vitest";
import { createSynthesisStore } from "../store.js";
import { noopAuditEmitter, type AuditEmitter, type SynthesisAuditEvent } from "../integrations/audit-emitter.js";
import { MANDATORY_LABEL, MODEL_PROVENANCE } from "../domain/serialize.js";
import {
  flagOutput,
  getOutput,
  listOutputsForProposal,
  synthesize,
  toggle,
} from "./ai-synthesis.js";
import { DomainError } from "../errors.js";

function buildInput() {
  return {
    proposal_id: "prop-1",
    arguments: [
      { content: "This bridge funding reduces traffic delay", stance: "agreement" as const },
      { content: "This bridge funding is wasteful and delay-prone", stance: "disagreement" as const },
    ],
    preferences: [{ description: "less traffic" }, { description: "Less Traffic" }],
  };
}

describe("synthesize", () => {
  it("stores and returns a full output with the mandatory label and provenance", () => {
    const store = createSynthesisStore();
    const result = synthesize(store, noopAuditEmitter, buildInput());
    expect("disabled" in result).toBe(false);
    if ("disabled" in result) throw new Error("unreachable");
    expect(result.label).toBe(MANDATORY_LABEL);
    expect(result.model_provenance).toEqual(MODEL_PROVENANCE);
    expect(store.getById(result.id)).toBeDefined();
  });

  it("short-circuits without storing anything while disabled", () => {
    const store = createSynthesisStore();
    store.setEnabled(false);
    const result = synthesize(store, noopAuditEmitter, buildInput());
    expect(result).toEqual({ disabled: true });
    expect(store.listByProposal("prop-1")).toEqual([]);
  });

  it("emits an audit event on every execution", () => {
    const store = createSynthesisStore();
    const events: SynthesisAuditEvent[] = [];
    const auditEmitter: AuditEmitter = { emit: (event) => events.push(event) };
    synthesize(store, auditEmitter, buildInput());
    expect(events).toHaveLength(1);
    expect(events[0]?.proposalId).toBe("prop-1");
  });

  it("does not emit an audit event while disabled", () => {
    const store = createSynthesisStore();
    store.setEnabled(false);
    const events: SynthesisAuditEvent[] = [];
    const auditEmitter: AuditEmitter = { emit: (event) => events.push(event) };
    synthesize(store, auditEmitter, buildInput());
    expect(events).toEqual([]);
  });
});

describe("toggle", () => {
  it("flips the store's enabled flag", () => {
    const store = createSynthesisStore();
    expect(toggle(store, false)).toEqual({ enabled: false });
    expect(store.isEnabled()).toBe(false);
    expect(toggle(store, true)).toEqual({ enabled: true });
    expect(store.isEnabled()).toBe(true);
  });
});

describe("flagOutput", () => {
  it("accumulates reasons across repeated calls", () => {
    const store = createSynthesisStore();
    const created = synthesize(store, noopAuditEmitter, buildInput());
    if ("disabled" in created) throw new Error("unreachable");

    flagOutput(store, created.id, "citizen-a", "seems biased");
    const second = flagOutput(store, created.id, "citizen-b", "misleading framing");

    expect(second.flagged).toBe(true);
    expect(second.flag_reasons).toHaveLength(2);
    expect(second.flag_reasons.map((r) => r.reason)).toEqual(["seems biased", "misleading framing"]);
    expect(second.flag_reasons.map((r) => r.citizen_id)).toEqual(["citizen-a", "citizen-b"]);
  });

  it("throws a 404 DomainError for an unknown output id", () => {
    const store = createSynthesisStore();
    expect(() => flagOutput(store, "missing-id", "citizen-a", "reason")).toThrow(DomainError);
    try {
      flagOutput(store, "missing-id", "citizen-a", "reason");
    } catch (err) {
      expect((err as DomainError).statusCode).toBe(404);
    }
  });
});

describe("getOutput / listOutputsForProposal", () => {
  it("returns a serialized output with provenance on every read", () => {
    const store = createSynthesisStore();
    const created = synthesize(store, noopAuditEmitter, buildInput());
    if ("disabled" in created) throw new Error("unreachable");

    const fetched = getOutput(store, created.id);
    expect(fetched.model_provenance).toEqual(MODEL_PROVENANCE);
    expect(fetched.label).toBe(MANDATORY_LABEL);

    const listed = listOutputsForProposal(store, "prop-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.model_provenance).toEqual(MODEL_PROVENANCE);
  });

  it("returns an empty list for a proposal with no outputs", () => {
    const store = createSynthesisStore();
    expect(listOutputsForProposal(store, "unknown-proposal")).toEqual([]);
  });

  it("throws a 404 DomainError for an unknown output id", () => {
    const store = createSynthesisStore();
    expect(() => getOutput(store, "missing-id")).toThrow(DomainError);
  });
});
