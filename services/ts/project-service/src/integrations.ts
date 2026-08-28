// audit-service (DP-036) and civic-duty-service (DP-053's assignment queue)
// are separate processes not implemented in this codebase yet. Both calls
// are modeled as injectable seams with no-op default implementations, per
// the cross-service simplification convention used across this phase.
export interface AuditEvent {
  type: string;
  projectId: string;
  at: Date;
  details?: Record<string, unknown>;
}

export interface AuditEmitter {
  emit(event: AuditEvent): void;
}

export const noopAuditEmitter: AuditEmitter = {
  emit: () => {},
};

export interface AssignmentRequester {
  request(projectId: string): void;
}

export const noopAssignmentRequester: AssignmentRequester = {
  request: () => {},
};

// ProposalAuthorLookup resolves a project's originating proposal author, so
// a "successful" outcome evaluation (DP-022) knows which citizen to credit
// via ReputationEmitter below. project-service only stores proposal_id
// (TBL-029), not the author, so this is a genuine read, not a fire-and-
// forget emit -- but its failure must not block the evaluation submission
// that triggered it, so callers treat a null/rejected result as "skip the
// reputation credit," not as an error.
export interface ProposalAuthorLookup {
  getAuthorId(proposalId: string): Promise<string | null>;
}

export const noopProposalAuthorLookup: ProposalAuthorLookup = {
  getAuthorId: async () => null,
};

// createHttpProposalAuthorLookup calls proposal-service's real
// GET /proposals/:id (SRV-004).
export function createHttpProposalAuthorLookup(baseUrl: string): ProposalAuthorLookup {
  return {
    async getAuthorId(proposalId) {
      try {
        const res = await fetch(`${baseUrl}/proposals/${encodeURIComponent(proposalId)}`);
        if (!res.ok) return null;
        const body = (await res.json()) as { author_id?: string };
        return body.author_id ?? null;
      } catch {
        return null;
      }
    },
  };
}

// LedgerRecorder models DP-019 (budget-service's real /budget/ledger
// endpoint). recordBudgetSpent (services/projects.ts) still writes
// project.budget_spent locally -- that's the fast, always-available path
// this service's own reads depend on -- but it also pushes a
// project-tagged outflow here so the spend is traceable in the
// government-wide public ledger too (TBL-028.project_id), not just kept in
// two disconnected records. Fire-and-forget, matching every other emitter
// in this codebase: a downed budget-service must not block the spend
// record that triggered it.
export interface LedgerRecorder {
  recordOutflow(projectId: string, amount: number, description: string): void;
}

export const noopLedgerRecorder: LedgerRecorder = {
  recordOutflow: () => {},
};

// createHttpLedgerRecorder calls budget-service's real
// POST /budget/ledger (SRV-007).
export function createHttpLedgerRecorder(baseUrl: string): LedgerRecorder {
  return {
    recordOutflow(projectId, amount, description) {
      fetch(`${baseUrl}/budget/ledger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category_id: null,
          project_id: projectId,
          type: "outflow",
          amount,
          description,
          recorded_by: "project-service",
        }),
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}

// ReputationEmitter models DP-038 (reputation-service ingest), fired by a
// "successful" outcome evaluation (DP-022: "Triggers DP-038"). Fire-and-
// forget, matching AuditEmitter's contract: a downed reputation-service
// must not block the evaluation it's reacting to.
export interface ReputationEmitter {
  emit(citizenId: string, factorType: string, delta: number, sourceRef: string): void;
}

export const noopReputationEmitter: ReputationEmitter = {
  emit: () => {},
};

// createHttpReputationEmitter calls reputation-service's real
// POST /reputation/records (SRV-014).
export function createHttpReputationEmitter(baseUrl: string): ReputationEmitter {
  return {
    emit(citizenId, factorType, delta, sourceRef) {
      fetch(`${baseUrl}/reputation/records`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          citizen_id: citizenId,
          factor_type: factorType,
          delta,
          source_ref: sourceRef,
        }),
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}
