import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { LedgerEntry, LedgerEntryType } from "../domain/types.js";
import { validation } from "../errors.js";

export interface RecordLedgerEntryInput {
  categoryId: string | null;
  projectId: string | null;
  type: LedgerEntryType;
  amount: number;
  description: string;
  recordedBy: string;
}

export function recordLedgerEntry(
  store: Store,
  input: RecordLedgerEntryInput,
): LedgerEntry {
  if (input.categoryId !== null && !store.categories.has(input.categoryId)) {
    throw validation(`category ${input.categoryId} does not exist`);
  }
  const entry: LedgerEntry = {
    id: randomUUID(),
    categoryId: input.categoryId,
    projectId: input.projectId,
    type: input.type,
    amount: input.amount,
    description: input.description,
    recordedBy: input.recordedBy,
    createdAt: new Date(),
  };
  store.ledgerEntries.push(entry);
  return entry;
}

export function listLedgerEntries(
  store: Store,
  categoryId?: string,
  projectId?: string,
): LedgerEntry[] {
  return store.ledgerEntries.filter(
    (e) =>
      (categoryId === undefined || e.categoryId === categoryId) &&
      (projectId === undefined || e.projectId === projectId),
  );
}

export function sumOutflowsByCategory(store: Store): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of store.ledgerEntries) {
    if (entry.type !== "outflow" || entry.categoryId === null) continue;
    totals.set(entry.categoryId, (totals.get(entry.categoryId) ?? 0) + entry.amount);
  }
  return totals;
}
