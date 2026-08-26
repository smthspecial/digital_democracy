import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { BudgetCategory, CategoryTreeNode } from "../domain/types.js";

export interface CreateCategoryInput {
  jurisdictionId: string;
  parentId: string | null;
  name: string;
}

export function createCategory(
  store: Store,
  input: CreateCategoryInput,
): BudgetCategory {
  const category: BudgetCategory = {
    id: randomUUID(),
    jurisdictionId: input.jurisdictionId,
    parentId: input.parentId,
    name: input.name,
    allocatedAmount: 0,
    createdAt: new Date(),
  };
  store.categories.set(category.id, category);
  return category;
}

export function getCategoryTree(
  store: Store,
  jurisdictionId: string,
): CategoryTreeNode[] {
  const inJurisdiction = [...store.categories.values()].filter(
    (c) => c.jurisdictionId === jurisdictionId,
  );
  const byId = new Map(inJurisdiction.map((c) => [c.id, c.id]));
  const nodes = new Map<string, CategoryTreeNode>(
    inJurisdiction.map((c) => [c.id, { ...c, children: [] }]),
  );

  const roots: CategoryTreeNode[] = [];
  for (const category of inJurisdiction) {
    const node = nodes.get(category.id)!;
    // A parent outside this jurisdiction (or missing) can't be nested under,
    // so the node surfaces as a root rather than being silently dropped.
    if (category.parentId !== null && byId.has(category.parentId)) {
      nodes.get(category.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
