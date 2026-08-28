export const config = {
  port: Number(process.env.PORT ?? 4010),
  // Optional: real cross-service wiring for ProposalAuthorLookup/ReputationEmitter.
  // Unset -> both fall back to no-op defaults so the service still runs standalone.
  proposalServiceUrl: process.env.PROPOSAL_SERVICE_URL || null,
  reputationServiceUrl: process.env.REPUTATION_SERVICE_URL || null,
  budgetServiceUrl: process.env.BUDGET_SERVICE_URL || null,
};
