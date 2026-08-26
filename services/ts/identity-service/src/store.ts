import type { Citizen, IdentityVerification } from "./domain/types.js";

export interface Store {
  insertCitizen(citizen: Citizen): void;
  getCitizen(id: string): Citizen | undefined;
  listCitizens(): Citizen[];
  findCitizenByLegalHash(legalIdentityHash: string): Citizen | undefined;
  updateCitizenStatus(id: string, status: Citizen["status"]): Citizen | undefined;
  insertVerification(verification: IdentityVerification): void;
  listVerificationsByCitizen(citizenId: string): IdentityVerification[];
}

export function createStore(): Store {
  const citizens = new Map<string, Citizen>();
  const verificationsByCitizen = new Map<string, IdentityVerification[]>();

  return {
    insertCitizen(citizen) {
      citizens.set(citizen.id, citizen);
    },
    getCitizen(id) {
      return citizens.get(id);
    },
    listCitizens() {
      return [...citizens.values()];
    },
    findCitizenByLegalHash(legalIdentityHash) {
      return [...citizens.values()].find((c) => c.legalIdentityHash === legalIdentityHash);
    },
    updateCitizenStatus(id, status) {
      const citizen = citizens.get(id);
      if (!citizen) return undefined;
      citizen.status = status;
      return citizen;
    },
    insertVerification(verification) {
      const existing = verificationsByCitizen.get(verification.citizenId) ?? [];
      existing.push(verification);
      verificationsByCitizen.set(verification.citizenId, existing);
    },
    listVerificationsByCitizen(citizenId) {
      return verificationsByCitizen.get(citizenId) ?? [];
    },
  };
}
