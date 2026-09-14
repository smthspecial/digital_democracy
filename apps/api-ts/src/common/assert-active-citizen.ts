import { ForbiddenDomainError } from "./domain-errors.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";

// AUTH-010's `citizen.active` condition repeats across every citizen-facing
// write in ProposalModule (and ProblemModule, built next) -- shared here
// rather than duplicated per service.
export async function assertActiveCitizen(checker: CitizenStatusChecker, citizenId: string): Promise<void> {
  if (!(await checker.isActive(citizenId))) {
    throw new ForbiddenDomainError("Citizen is not active");
  }
}
