import { randomUUID } from "node:crypto";
import type { CivicAssignment, CivicAssignmentType, ParticipationRecord } from "./domain/types.js";

function participationKey(citizenId: string, period: string): string {
  return `${citizenId}::${period}`;
}

export interface Store {
  createAssignment(input: Omit<CivicAssignment, "id">): CivicAssignment;
  saveAssignment(assignment: CivicAssignment): CivicAssignment;
  getAssignment(id: string): CivicAssignment | undefined;
  listAssignmentsByCitizen(citizenId: string): CivicAssignment[];
  countOpenAssignments(citizenId: string): number;
  hasOpenAssignmentOfType(citizenId: string, type: CivicAssignmentType): boolean;
  upsertParticipationRecord(record: Omit<ParticipationRecord, "id"> & { id?: string }): ParticipationRecord;
  getParticipationRecord(citizenId: string, period: string): ParticipationRecord | undefined;
  listParticipationRecordsByPeriod(period: string): ParticipationRecord[];
}

export function createStore(): Store {
  const assignments = new Map<string, CivicAssignment>();
  const participationRecords = new Map<string, ParticipationRecord>();

  return {
    createAssignment(input) {
      const assignment: CivicAssignment = { ...input, id: randomUUID() };
      assignments.set(assignment.id, assignment);
      return assignment;
    },

    saveAssignment(assignment) {
      assignments.set(assignment.id, assignment);
      return assignment;
    },

    getAssignment(id) {
      return assignments.get(id);
    },

    listAssignmentsByCitizen(citizenId) {
      return [...assignments.values()].filter((a) => a.citizenId === citizenId);
    },

    countOpenAssignments(citizenId) {
      return [...assignments.values()].filter(
        (a) => a.citizenId === citizenId && a.status === "assigned",
      ).length;
    },

    hasOpenAssignmentOfType(citizenId, type) {
      return [...assignments.values()].some(
        (a) => a.citizenId === citizenId && a.type === type && a.status === "assigned",
      );
    },

    upsertParticipationRecord(record) {
      const key = participationKey(record.citizenId, record.period);
      const existing = participationRecords.get(key);
      const saved: ParticipationRecord = { ...record, id: record.id ?? existing?.id ?? randomUUID() };
      participationRecords.set(key, saved);
      return saved;
    },

    getParticipationRecord(citizenId, period) {
      return participationRecords.get(participationKey(citizenId, period));
    },

    listParticipationRecordsByPeriod(period) {
      return [...participationRecords.values()].filter((r) => r.period === period);
    },
  };
}
