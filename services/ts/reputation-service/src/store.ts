import type { ReputationRecord } from "./domain/types.js";

export interface ReputationStore {
  addRecord(record: ReputationRecord): void;
  listByCitizen(citizenId: string): ReputationRecord[];
}

export function createStore(): ReputationStore {
  const records: ReputationRecord[] = [];

  return {
    addRecord(record) {
      records.push(record);
    },
    listByCitizen(citizenId) {
      return records.filter((record) => record.citizenId === citizenId);
    },
  };
}
