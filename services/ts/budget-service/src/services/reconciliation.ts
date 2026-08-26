import type { Store } from "../store.js";
import type { ReconciliationResult } from "../domain/types.js";
import { sumOutflowsByCategory } from "./ledger.js";

// Models DP-055's "surface discrepancies to the audit pool" step: audit-service
// isn't implemented here, so this is an in-process notification hook (no-op
// by default) instead of a real cross-service emission or message queue.
export interface AlertEmitter {
  emit(categoryId: string, discrepancy: number): void;
}

export const noopAlertEmitter: AlertEmitter = {
  emit: () => undefined,
};

export function reconcile(
  store: Store,
  alertEmitter: AlertEmitter,
): ReconciliationResult[] {
  const spentByCategory = sumOutflowsByCategory(store);
  const results: ReconciliationResult[] = [];

  for (const category of store.categories.values()) {
    const spent = spentByCategory.get(category.id) ?? 0;
    const allocated = category.allocatedAmount;
    const discrepancy = allocated - spent;

    results.push({ categoryId: category.id, allocated, spent, discrepancy });

    if (discrepancy !== 0) {
      alertEmitter.emit(category.id, discrepancy);
    }
  }

  return results;
}
