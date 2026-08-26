import { randomUUID } from "node:crypto";
import {
  SUPPORT_THRESHOLD_RATIO,
  TERMINAL_STATUSES,
  type ProposalRecord,
  type ProposalStatus,
} from "../domain/types.js";
import type { ProposalStore } from "../store.js";
import type {
  AuditEmitter,
  ConstitutionalReviewer,
  VoteSessionRequester,
} from "../integrations.js";
import { conflict, notFound } from "../errors.js";

export interface ProposalServiceDeps {
  store: ProposalStore;
  constitutionalReviewer: ConstitutionalReviewer;
  voteSessionRequester: VoteSessionRequester;
  auditEmitter: AuditEmitter;
}

export interface CreateProposalInput {
  problemId: string;
  authorId: string;
  title: string;
  description: string;
}

export interface AddConstraintInput {
  authorId: string;
  text: string;
}

export interface UpsertBudgetInput {
  cost?: number;
  fundingSource?: string;
  maintenanceCost?: number;
  expectedBenefits?: string;
}

export interface AssignScopeInput {
  scopeJurisdictionId: string;
  population: number;
}

export interface FileScopeChallengeInput {
  citizenId: string;
  reason: string;
}

export type ResolveOutcome = "approved" | "rejected" | "archived";

const CONSTRAINT_ADD_STATUSES: readonly ProposalStatus[] = [
  "draft",
  "gathering_support",
  "development",
];

export function createProposalService(deps: ProposalServiceDeps) {
  function getOrThrow(id: string): ProposalRecord {
    const proposal = deps.store.get(id);
    if (!proposal) {
      throw notFound(`proposal ${id} not found`);
    }
    return proposal;
  }

  function emitTransition(
    proposal: ProposalRecord,
    from: ProposalStatus,
    to: ProposalStatus,
  ): void {
    deps.auditEmitter.emit("proposal.status_changed", {
      proposalId: proposal.id,
      from,
      to,
    });
  }

  function createProposal(input: CreateProposalInput): ProposalRecord {
    const proposal: ProposalRecord = {
      id: randomUUID(),
      problemId: input.problemId,
      authorId: input.authorId,
      title: input.title,
      description: input.description,
      status: "draft",
      scopeJurisdictionId: null,
      supportCount: 0,
      supportThreshold: null,
      scopeChallengePending: false,
      createdAt: new Date(),
      budget: {
        cost: null,
        fundingSource: null,
        maintenanceCost: null,
        expectedBenefits: null,
      },
      constraints: [],
      scopeChallenges: [],
      supporterIds: new Set(),
    };
    deps.store.save(proposal);
    deps.auditEmitter.emit("proposal.created", { proposalId: proposal.id });
    return proposal;
  }

  function addConstraint(
    id: string,
    input: AddConstraintInput,
  ): ProposalRecord {
    const proposal = getOrThrow(id);
    if (!CONSTRAINT_ADD_STATUSES.includes(proposal.status)) {
      throw conflict(
        `cannot add a constraint while proposal status is ${proposal.status}`,
      );
    }
    proposal.constraints.push({
      id: randomUUID(),
      proposalId: proposal.id,
      authorId: input.authorId,
      text: input.text,
      agreed: false,
      createdAt: new Date(),
    });
    return proposal;
  }

  function upsertBudget(id: string, input: UpsertBudgetInput): ProposalRecord {
    const proposal = getOrThrow(id);
    if (input.cost !== undefined) proposal.budget.cost = input.cost;
    if (input.fundingSource !== undefined)
      proposal.budget.fundingSource = input.fundingSource;
    if (input.maintenanceCost !== undefined)
      proposal.budget.maintenanceCost = input.maintenanceCost;
    if (input.expectedBenefits !== undefined)
      proposal.budget.expectedBenefits = input.expectedBenefits;
    return proposal;
  }

  function assignScope(id: string, input: AssignScopeInput): ProposalRecord {
    const proposal = getOrThrow(id);
    proposal.scopeJurisdictionId = input.scopeJurisdictionId;
    proposal.supportThreshold = Math.ceil(
      input.population * SUPPORT_THRESHOLD_RATIO,
    );
    return proposal;
  }

  function fileScopeChallenge(
    id: string,
    input: FileScopeChallengeInput,
  ): ProposalRecord {
    const proposal = getOrThrow(id);
    proposal.scopeChallenges.push({
      id: randomUUID(),
      proposalId: proposal.id,
      citizenId: input.citizenId,
      reason: input.reason,
      resolved: false,
      createdAt: new Date(),
      resolvedAt: null,
    });
    proposal.scopeChallengePending = true;
    return proposal;
  }

  function resolveScopeChallenge(
    id: string,
    challengeId: string,
  ): ProposalRecord {
    const proposal = getOrThrow(id);
    const challenge = proposal.scopeChallenges.find(
      (c) => c.id === challengeId,
    );
    if (!challenge) {
      throw notFound(`scope challenge ${challengeId} not found`);
    }
    if (challenge.resolved) {
      throw conflict(`scope challenge ${challengeId} already resolved`);
    }
    challenge.resolved = true;
    challenge.resolvedAt = new Date();
    proposal.scopeChallengePending = false;
    return proposal;
  }

  function addSupport(id: string, citizenId: string): ProposalRecord {
    const proposal = getOrThrow(id);
    if (proposal.supporterIds.has(citizenId)) {
      throw conflict(`citizen ${citizenId} already supported this proposal`);
    }
    proposal.supporterIds.add(citizenId);
    proposal.supportCount += 1;
    return proposal;
  }

  function votingGateMissingFields(proposal: ProposalRecord): string[] {
    const missing: string[] = [];
    if (proposal.budget.cost === null) missing.push("cost");
    if (proposal.budget.fundingSource === null) missing.push("funding_source");
    if (proposal.budget.maintenanceCost === null)
      missing.push("maintenance_cost");
    if (proposal.budget.expectedBenefits === null)
      missing.push("expected_benefits");
    if (proposal.scopeJurisdictionId === null)
      missing.push("scope_jurisdiction_id");
    return missing;
  }

  function advance(id: string): ProposalRecord {
    const proposal = getOrThrow(id);
    const from = proposal.status;

    if (from === "draft") {
      proposal.status = "gathering_support";
      emitTransition(proposal, from, proposal.status);
      return proposal;
    }

    if (from === "gathering_support") {
      const threshold = proposal.supportThreshold;
      if (threshold === null || proposal.supportCount < threshold) {
        throw conflict(
          `support count ${proposal.supportCount} has not reached the required threshold ${
            threshold ?? "unset"
          }`,
        );
      }
      proposal.status = "development";
      emitTransition(proposal, from, proposal.status);
      return proposal;
    }

    if (from === "development") {
      const missing = votingGateMissingFields(proposal);
      if (missing.length > 0) {
        throw conflict(`missing required fields: ${missing.join(", ")}`);
      }
      if (proposal.scopeChallengePending) {
        throw conflict("a scope challenge is pending for this proposal");
      }
      const review = deps.constitutionalReviewer.review(proposal.id);
      if (review.blocked) {
        throw conflict("blocked by constitutional review");
      }
      proposal.status = "voting";
      emitTransition(proposal, from, proposal.status);
      deps.voteSessionRequester.requestSession(proposal.id);
      return proposal;
    }

    throw conflict(`no automatic advance is defined from status ${from}`);
  }

  function resolveProposal(
    id: string,
    outcome: ResolveOutcome,
  ): ProposalRecord {
    const proposal = getOrThrow(id);
    const from = proposal.status;

    if (outcome === "archived") {
      if (TERMINAL_STATUSES.includes(from)) {
        throw conflict(`cannot archive a proposal from status ${from}`);
      }
    } else if (from !== "voting") {
      throw conflict(
        `proposal can only be resolved to ${outcome} from status voting, current status is ${from}`,
      );
    }

    proposal.status = outcome;
    emitTransition(proposal, from, proposal.status);
    return proposal;
  }

  function get(id: string): ProposalRecord {
    return getOrThrow(id);
  }

  function list(): ProposalRecord[] {
    return deps.store.list();
  }

  return {
    createProposal,
    addConstraint,
    upsertBudget,
    assignScope,
    fileScopeChallenge,
    resolveScopeChallenge,
    addSupport,
    advance,
    resolveProposal,
    get,
    list,
  };
}

export type ProposalService = ReturnType<typeof createProposalService>;
