import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type {
  AllocationAggregateResult,
  BudgetAllocationVote,
} from "../domain/types.js";
import { validation } from "../errors.js";

export interface AllocationInput {
  categoryId: string;
  percentage: number;
}

export interface SubmitAllocationsInput {
  citizenId: string;
  period: string;
  allocations: AllocationInput[];
}

const SUM_TOLERANCE = 1e-9;

export function submitAllocations(
  store: Store,
  input: SubmitAllocationsInput,
): BudgetAllocationVote[] {
  const seen = new Set<string>();
  for (const allocation of input.allocations) {
    if (seen.has(allocation.categoryId)) {
      throw validation(
        `duplicate category_id ${allocation.categoryId} in allocation set`,
      );
    }
    seen.add(allocation.categoryId);
    if (!store.categories.has(allocation.categoryId)) {
      throw validation(`category ${allocation.categoryId} does not exist`);
    }
  }

  const sum = input.allocations.reduce((acc, a) => acc + a.percentage, 0);
  if (Math.abs(sum - 100) > SUM_TOLERANCE) {
    throw validation(`allocation percentages must sum to 100, got ${sum}`);
  }

  for (const [id, vote] of store.allocationVotes) {
    if (vote.citizenId === input.citizenId && vote.period === input.period) {
      store.allocationVotes.delete(id);
    }
  }

  const created = input.allocations.map((allocation): BudgetAllocationVote => {
    const vote: BudgetAllocationVote = {
      id: randomUUID(),
      citizenId: input.citizenId,
      categoryId: allocation.categoryId,
      percentage: allocation.percentage,
      period: input.period,
      createdAt: new Date(),
    };
    store.allocationVotes.set(vote.id, vote);
    return vote;
  });

  return created;
}

export function aggregateAllocations(
  store: Store,
  period: string,
  totalPool: number,
): AllocationAggregateResult[] {
  const votesByCategory = new Map<string, number[]>();
  for (const vote of store.allocationVotes.values()) {
    if (vote.period !== period) continue;
    const percentages = votesByCategory.get(vote.categoryId) ?? [];
    percentages.push(vote.percentage);
    votesByCategory.set(vote.categoryId, percentages);
  }

  const results: AllocationAggregateResult[] = [];
  for (const [categoryId, percentages] of votesByCategory) {
    const category = store.categories.get(categoryId);
    if (!category) continue;

    const averagePercentage =
      percentages.reduce((acc, p) => acc + p, 0) / percentages.length;
    const allocatedAmount = (totalPool * averagePercentage) / 100;

    category.allocatedAmount = allocatedAmount;

    results.push({
      categoryId,
      averagePercentage,
      voteCount: percentages.length,
      allocatedAmount,
    });
  }

  return results;
}
