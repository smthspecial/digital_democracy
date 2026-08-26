export type RandomSource = () => number;

export interface WeightInput {
  citizenId: string;
  sphereRelevant: boolean;
  competencyMatch: boolean;
  openAssignmentCount: number;
}

export interface WeightedCandidate extends WeightInput {
  jitter: number;
  weight: number;
}

// FR-050 weighting: base 1, +0.5 for sphere-of-impact relevance, +0.5 for
// competency match (each a bounded, comparable bonus so no single factor
// dominates), divided by (1 + openAssignmentCount) as a workload penalty that
// shrinks weight as a citizen's own open-assignment load grows, then
// multiplied by a random jitter in [0.75, 1.25) drawn from the injectable
// random source so the pick is never fully deterministic.
export function computeWeight(input: WeightInput, random: RandomSource): WeightedCandidate {
  const base = 1 + (input.sphereRelevant ? 0.5 : 0) + (input.competencyMatch ? 0.5 : 0);
  const workloadAdjusted = base / (1 + input.openAssignmentCount);
  const jitter = 0.75 + random() * 0.5;
  return { ...input, jitter, weight: workloadAdjusted * jitter };
}

// Cumulative-weight weighted-random pick: draws a single value from `random`
// scaled to the total weight, then walks candidates in order accumulating
// weight until the draw falls inside a candidate's range.
export function pickWeighted<T extends { weight: number }>(candidates: T[], random: RandomSource): T {
  if (candidates.length === 0) {
    throw new Error("pickWeighted requires at least one candidate");
  }
  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  const draw = random() * totalWeight;
  let cumulative = 0;
  for (const candidate of candidates) {
    cumulative += candidate.weight;
    if (draw < cumulative) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1]!;
}
