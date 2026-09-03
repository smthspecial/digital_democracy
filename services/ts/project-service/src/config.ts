export const config = {
  port: Number(process.env.PORT ?? 4010),
  // Optional: real cross-service wiring for ProposalAuthorLookup/ReputationEmitter.
  // Unset -> both fall back to no-op defaults so the service still runs standalone.
  proposalServiceUrl: process.env.PROPOSAL_SERVICE_URL || null,
  reputationServiceUrl: process.env.REPUTATION_SERVICE_URL || null,
  budgetServiceUrl: process.env.BUDGET_SERVICE_URL || null,
  // Optional: real queue wiring for AuditEmitter via the audit.append queue (ADR-023).
  // Unset -> falls back to the no-op default so the service still runs standalone.
  natsUrl: process.env.NATS_URL || null,
};
