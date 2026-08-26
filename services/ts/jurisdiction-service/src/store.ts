import type { Jurisdiction, Membership, Residency } from "./domain/types.js";

export function createStore() {
  const jurisdictions = new Map<string, Jurisdiction>();
  const residencies = new Map<string, Residency>();
  const memberships = new Map<string, Membership>();

  return {
    jurisdictions: {
      insert(jurisdiction: Jurisdiction): Jurisdiction {
        jurisdictions.set(jurisdiction.id, jurisdiction);
        return jurisdiction;
      },
      update(jurisdiction: Jurisdiction): Jurisdiction {
        jurisdictions.set(jurisdiction.id, jurisdiction);
        return jurisdiction;
      },
      getById(id: string): Jurisdiction | undefined {
        return jurisdictions.get(id);
      },
      listChildren(parentId: string): Jurisdiction[] {
        return [...jurisdictions.values()].filter((j) => j.parent_id === parentId);
      },
    },
    residencies: {
      insert(residency: Residency): Residency {
        residencies.set(residency.id, residency);
        return residency;
      },
      listByCitizenAndJurisdiction(citizenId: string, jurisdictionId: string): Residency[] {
        return [...residencies.values()].filter(
          (r) => r.citizen_id === citizenId && r.jurisdiction_id === jurisdictionId,
        );
      },
    },
    memberships: {
      insert(membership: Membership): Membership {
        memberships.set(membership.id, membership);
        return membership;
      },
      listByCitizen(citizenId: string): Membership[] {
        return [...memberships.values()].filter((m) => m.citizen_id === citizenId);
      },
      find(citizenId: string, jurisdictionId: string): Membership | undefined {
        return [...memberships.values()].find(
          (m) => m.citizen_id === citizenId && m.jurisdiction_id === jurisdictionId,
        );
      },
    },
  };
}

export type Store = ReturnType<typeof createStore>;
