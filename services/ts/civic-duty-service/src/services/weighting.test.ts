import { describe, expect, it } from "vitest";
import { computeWeight, pickWeighted, type WeightedCandidate } from "./weighting.js";

function fixedRandom(...values: number[]) {
  let i = 0;
  return () => {
    const v = values[i % values.length]!;
    i += 1;
    return v;
  };
}

describe("computeWeight", () => {
  it("gives base weight 1 with no bonuses, no workload, and neutral jitter", () => {
    const result = computeWeight(
      { citizenId: "c1", sphereRelevant: false, competencyMatch: false, openAssignmentCount: 0 },
      fixedRandom(0.5),
    );
    expect(result.weight).toBeCloseTo(1.0);
  });

  it("adds 0.5 for sphere relevance and 0.5 for competency match", () => {
    const result = computeWeight(
      { citizenId: "c1", sphereRelevant: true, competencyMatch: true, openAssignmentCount: 0 },
      fixedRandom(0),
    );
    // base = 1 + 0.5 + 0.5 = 2, workload divisor = 1/(1+0) = 1, jitter at random()=0 is 0.75
    expect(result.weight).toBeCloseTo(2 * 0.75);
  });

  it("shrinks weight as open assignment count grows", () => {
    const low = computeWeight(
      { citizenId: "c1", sphereRelevant: true, competencyMatch: true, openAssignmentCount: 0 },
      fixedRandom(0),
    );
    const high = computeWeight(
      { citizenId: "c2", sphereRelevant: true, competencyMatch: true, openAssignmentCount: 3 },
      fixedRandom(0),
    );
    expect(high.weight).toBeLessThan(low.weight);
    expect(high.weight).toBeCloseTo(2 / 4 * 0.75);
  });

  it("keeps jitter within the documented [0.75, 1.25) multiplicative band", () => {
    const atZero = computeWeight(
      { citizenId: "c1", sphereRelevant: false, competencyMatch: false, openAssignmentCount: 0 },
      fixedRandom(0),
    );
    const nearOne = computeWeight(
      { citizenId: "c1", sphereRelevant: false, competencyMatch: false, openAssignmentCount: 0 },
      fixedRandom(0.999999),
    );
    expect(atZero.jitter).toBeCloseTo(0.75);
    expect(nearOne.jitter).toBeLessThan(1.25);
    expect(nearOne.jitter).toBeGreaterThan(1.24);
  });
});

describe("pickWeighted", () => {
  const candidates: WeightedCandidate[] = [
    {
      citizenId: "a",
      sphereRelevant: false,
      competencyMatch: false,
      openAssignmentCount: 0,
      jitter: 1,
      weight: 1,
    },
    {
      citizenId: "b",
      sphereRelevant: false,
      competencyMatch: false,
      openAssignmentCount: 0,
      jitter: 1,
      weight: 3,
    },
  ];
  // total weight = 4, cumulative ranges: a -> [0, 1), b -> [1, 4)

  it("picks the candidate whose cumulative range contains the draw", () => {
    const lowDraw = pickWeighted(candidates, fixedRandom(0.1)); // draw = 0.1 * 4 = 0.4 -> falls in a's [0,1)
    expect(lowDraw.citizenId).toBe("a");

    const highDraw = pickWeighted(candidates, fixedRandom(0.5)); // draw = 0.5 * 4 = 2.0 -> falls in b's [1,4)
    expect(highDraw.citizenId).toBe("b");
  });

  it("picks a lower-workload candidate over an identical-weight-otherwise higher-workload one when the draw lands in the low-workload range", () => {
    const low: WeightedCandidate = {
      citizenId: "low-workload",
      sphereRelevant: true,
      competencyMatch: false,
      openAssignmentCount: 0,
      jitter: 0.75,
      weight: 1.5 * 0.75, // (1 + 0.5) / (1 + 0) * 0.75
    };
    const high: WeightedCandidate = {
      citizenId: "high-workload",
      sphereRelevant: true,
      competencyMatch: false,
      openAssignmentCount: 2,
      jitter: 0.75,
      weight: (1.5 / 3) * 0.75, // (1 + 0.5) / (1 + 2) * 0.75
    };
    // total = 1.125 + 0.375 = 1.5, low's cumulative range is [0, 1.125)
    const draw = fixedRandom(0.5); // draw = 0.5 * 1.5 = 0.75, inside low's range
    expect(pickWeighted([low, high], draw).citizenId).toBe("low-workload");
  });
});
