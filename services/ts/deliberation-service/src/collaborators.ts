export interface AuditEmitter {
  emit(eventType: string, payload: Record<string, unknown>): void;
}

// DP-036's audit-service (SRV-012) isn't reachable from this codebase yet;
// model the hash-chained append as an injectable emitter with a no-op default.
export const noopAuditEmitter: AuditEmitter = {
  emit: () => {},
};

export interface SynthesisTrigger {
  trigger(subjectId: string): void;
}

// DP-037's AI synthesis worker (SRV-016) isn't reachable from this codebase
// yet; model the "argument/preference volume crossed threshold" signal as an
// injectable trigger, no-op by default. Called with proposal_id for
// arguments and problem_id for preferences, since preference rows are tied
// to a problem rather than a proposal (see TBL-018).
export const noopSynthesisTrigger: SynthesisTrigger = {
  trigger: () => {},
};

export const DEFAULT_SYNTHESIS_THRESHOLD = 5;

// No ReputationEmitter seam is modeled here, unlike AuditEmitter and
// SynthesisTrigger above: SRV-014 lists deliberation-service among
// reputation-service's event sources for the "constructive" positive
// factor, but nothing in this service's feature set scores an argument's
// constructiveness -- posting one (DeliberationArgument) carries no
// quality signal at all, only stance and evidence_ref. Wiring a seam here
// would mean inventing a scoring heuristic with no specification behind
// it, so this stays an acknowledged gap rather than a fabricated trigger
// until a real "constructive" signal (e.g. a moderation or endorsement
// feature) exists to drive it.
