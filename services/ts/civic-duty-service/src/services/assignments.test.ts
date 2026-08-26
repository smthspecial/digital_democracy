import { describe, expect, it } from "vitest";
import { createStore } from "../store.js";
import {
  generateAssignment,
  transitionAssignment,
  rebalance,
  refreshAuditPool,
} from "./assignments.js";

function fixedRandom(...values: number[]) {
  let i = 0;
  return () => {
    const v = values[i % values.length]!;
    i += 1;
    return v;
  };
}

describe("generateAssignment", () => {
  it("assigns to the candidate whose cumulative-weight range contains the draw, factoring in each candidate's current open-assignment count from the store", () => {
    const store = createStore();
    // seed "busy" with two pre-existing open assignments so its own workload
    // (read from the store, not from caller input) drags its weight down.
    store.createAssignment({
      citizenId: "busy",
      type: "proposal_review",
      targetRef: "prior-1",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    });
    store.createAssignment({
      citizenId: "busy",
      type: "proposal_review",
      targetRef: "prior-2",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    });

    // Every random() call returns 0 -> jitter is fixed at 0.75 for both
    // candidates, and the final draw is 0 (the very start of the range),
    // which always lands on the first candidate by construction. So instead
    // we assert on the underlying weights rather than the pick itself here;
    // the pick-lands-in-range behavior is covered by weighting.test.ts and
    // the "picks the free candidate" case below.
    const result = generateAssignment(store, fixedRandom(0), {
      type: "proposal_review",
      targetRef: "target-1",
      candidates: [
        { citizenId: "busy", sphereRelevant: false, competencyMatch: false },
        { citizenId: "free", sphereRelevant: false, competencyMatch: false },
      ],
    });

    const busyWeight = result.weights.find((w) => w.citizenId === "busy")!;
    const freeWeight = result.weights.find((w) => w.citizenId === "free")!;
    expect(busyWeight.openAssignmentCount).toBe(2);
    expect(freeWeight.openAssignmentCount).toBe(0);
    expect(freeWeight.weight).toBeGreaterThan(busyWeight.weight);
  });

  it("picks the free candidate when the draw lands past the busy candidate's cumulative range", () => {
    const store = createStore();
    store.createAssignment({
      citizenId: "busy",
      type: "proposal_review",
      targetRef: "prior-1",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    });

    // random() is called once per candidate for jitter (busy, then free),
    // then once more for the final draw -- all three fixed at [0, 0, 0.9]:
    // busy: base 1 / (1+1) = 0.5, jitter 0.75 -> weight 0.375
    // free: base 1 / (1+0) = 1, jitter 0.75 -> weight 0.75
    // total = 1.125, busy's cumulative range is [0, 0.375)
    // draw = 0.9 * 1.125 = 1.0125 -> lands in free's range [0.375, 1.125)
    const result = generateAssignment(store, fixedRandom(0, 0, 0.9), {
      type: "proposal_review",
      targetRef: "target-1",
      candidates: [
        { citizenId: "busy", sphereRelevant: false, competencyMatch: false },
        { citizenId: "free", sphereRelevant: false, competencyMatch: false },
      ],
    });

    expect(result.assignment.citizenId).toBe("free");
    expect(result.assignment.status).toBe("assigned");
    expect(result.assignment.type).toBe("proposal_review");
    expect(store.countOpenAssignments("free")).toBe(1);
  });

  it("rejects an empty candidate list", () => {
    const store = createStore();
    expect(() =>
      generateAssignment(store, fixedRandom(0), {
        type: "proposal_review",
        targetRef: "target-1",
        candidates: [],
      }),
    ).toThrow(/candidate/i);
  });
});

describe("transitionAssignment", () => {
  function seedAssignment(store: ReturnType<typeof createStore>) {
    return store.createAssignment({
      citizenId: "c1",
      type: "proposal_review",
      targetRef: "t1",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    });
  }

  it("accept leaves the assignment in 'assigned' status", () => {
    const store = createStore();
    const assignment = seedAssignment(store);
    const result = transitionAssignment(store, assignment.id, "accept");
    expect(result.status).toBe("assigned");
  });

  it("abandon moves the assignment to 'abandoned'", () => {
    const store = createStore();
    const assignment = seedAssignment(store);
    const result = transitionAssignment(store, assignment.id, "abandon");
    expect(result.status).toBe("abandoned");
  });

  it("complete moves the assignment to 'completed'", () => {
    const store = createStore();
    const assignment = seedAssignment(store);
    const result = transitionAssignment(store, assignment.id, "complete");
    expect(result.status).toBe("completed");
  });

  it("throws not-found for an unknown id", () => {
    const store = createStore();
    expect(() => transitionAssignment(store, "nope", "accept")).toThrow();
  });

  it("rejects transitions on an already-terminal assignment", () => {
    const store = createStore();
    const assignment = seedAssignment(store);
    transitionAssignment(store, assignment.id, "complete");
    expect(() => transitionAssignment(store, assignment.id, "abandon")).toThrow();
  });
});

describe("rebalance", () => {
  it("classifies zero-assignment citizens as underloaded and over-threshold citizens as overloaded", () => {
    const store = createStore();
    store.createAssignment({
      citizenId: "over",
      type: "proposal_review",
      targetRef: "t1",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    });
    store.createAssignment({
      citizenId: "over",
      type: "proposal_review",
      targetRef: "t2",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    });
    store.createAssignment({
      citizenId: "at-threshold",
      type: "proposal_review",
      targetRef: "t3",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    });

    const result = rebalance(store, ["over", "at-threshold", "empty"], 1);
    expect(result.overloaded).toEqual(["over"]);
    expect(result.underloaded).toEqual(["empty"]);
  });
});

describe("refreshAuditPool", () => {
  it("never selects a citizen who already holds an open audit_review assignment", () => {
    const store = createStore();
    store.createAssignment({
      citizenId: "already-auditing",
      type: "audit_review",
      targetRef: "existing",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    });

    const created = refreshAuditPool(store, fixedRandom(0), ["already-auditing", "eligible"], 5);
    expect(created).toHaveLength(1);
    expect(created[0]!.citizenId).toBe("eligible");
    expect(created[0]!.type).toBe("audit_review");
  });

  it("selects at most `count` citizens", () => {
    const store = createStore();
    const created = refreshAuditPool(store, fixedRandom(0.1, 0.5, 0.9), ["a", "b", "c"], 2);
    expect(created).toHaveLength(2);
  });

  it("a citizen with a completed (non-open) audit_review assignment is still eligible", () => {
    const store = createStore();
    store.createAssignment({
      citizenId: "past-auditor",
      type: "audit_review",
      targetRef: "old",
      assignedAt: new Date(),
      dueAt: null,
      status: "completed",
    });
    const created = refreshAuditPool(store, fixedRandom(0), ["past-auditor"], 1);
    expect(created).toHaveLength(1);
    expect(created[0]!.citizenId).toBe("past-auditor");
  });
});
