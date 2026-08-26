import type {
  ExpertDomain,
  Competency,
  ConflictOfInterest,
  ExpertAssessment,
  CompetencyChallenge,
} from "./domain/types.js";

export function serializeDomain(domain: ExpertDomain) {
  return { id: domain.id, name: domain.name, description: domain.description };
}

export function serializeCompetency(competency: Competency) {
  return {
    id: competency.id,
    citizen_id: competency.citizenId,
    domain_id: competency.domainId,
    level: competency.level,
    status: competency.status,
    stage: competency.stage,
    granted_at: competency.grantedAt ? competency.grantedAt.toISOString() : null,
    expires_at: competency.expiresAt ? competency.expiresAt.toISOString() : null,
  };
}

export function serializeConflict(coi: ConflictOfInterest) {
  return {
    id: coi.id,
    citizen_id: coi.citizenId,
    domain_id: coi.domainId,
    description: coi.description,
    disclosed_at: coi.disclosedAt.toISOString(),
  };
}

export function serializeAssessment(assessment: ExpertAssessment) {
  return {
    id: assessment.id,
    proposal_id: assessment.proposalId,
    citizen_id: assessment.expertId,
    domain_id: assessment.domainId,
    content: assessment.content,
    score: assessment.score,
    created_at: assessment.createdAt.toISOString(),
  };
}

export function serializeChallenge(challenge: CompetencyChallenge) {
  return {
    id: challenge.id,
    competency_id: challenge.competencyId,
    challenger_id: challenge.challengerId,
    evidence_ref: challenge.evidenceRef,
    reason: challenge.reason,
    status: challenge.status,
    decision: challenge.decision,
  };
}
