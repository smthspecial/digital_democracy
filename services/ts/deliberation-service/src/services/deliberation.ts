import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { DeliberationArgument, Preference, Stance } from "../domain/types.js";
import type { AuditEmitter, SynthesisTrigger } from "../collaborators.js";
import { conflict, notFound, validation } from "../errors.js";

export interface PostArgumentInput {
  proposal_id: string;
  citizen_id: string;
  parent_id?: string | null;
  content: string;
  evidence_ref: string;
  stance: Stance;
}

export interface DeclarePreferenceInput {
  problem_id: string;
  citizen_id: string;
  description: string;
}

export interface DeliberationServiceCollaborators {
  auditEmitter: AuditEmitter;
  synthesisTrigger: SynthesisTrigger;
  synthesisThreshold: number;
}

export function createDeliberationService(store: Store, collaborators: DeliberationServiceCollaborators) {
  // A locked agreement-stance argument locks its whole subtree, not just
  // itself -- the stronger reading of "prevent re-litigation of established
  // facts". Walk from the reply target up through its ancestors; a lock
  // anywhere on that chain blocks the reply.
  function isWithinLockedSubtree(argumentId: string): boolean {
    let current = store.argumentsById.get(argumentId);
    while (current) {
      if (current.locked) return true;
      current = current.parent_id ? store.argumentsById.get(current.parent_id) : undefined;
    }
    return false;
  }

  // DP-037 fires once per threshold multiple crossed (5, 10, 15, ...)
  // rather than once-then-never-again, so it keeps firing as volume grows
  // without needing an explicit "synthesis completed" reset signal.
  function bumpAndMaybeTrigger(counts: Map<string, number>, subjectId: string): void {
    const previous = counts.get(subjectId) ?? 0;
    const next = previous + 1;
    counts.set(subjectId, next);
    const threshold = collaborators.synthesisThreshold;
    if (Math.floor(previous / threshold) !== Math.floor(next / threshold)) {
      collaborators.synthesisTrigger.trigger(subjectId);
    }
  }

  function postArgument(input: PostArgumentInput): DeliberationArgument {
    const parentId = input.parent_id ?? null;
    if (parentId) {
      if (!store.argumentsById.has(parentId)) {
        throw notFound("parent argument not found");
      }
      if (isWithinLockedSubtree(parentId)) {
        throw conflict("cannot reply within a locked branch");
      }
    }

    const argument: DeliberationArgument = {
      id: randomUUID(),
      proposal_id: input.proposal_id,
      citizen_id: input.citizen_id,
      parent_id: parentId,
      content: input.content,
      evidence_ref: input.evidence_ref,
      stance: input.stance,
      locked: false,
      created_at: new Date(),
    };
    store.argumentsById.set(argument.id, argument);

    collaborators.auditEmitter.emit("deliberation.argument.posted", {
      argument_id: argument.id,
      proposal_id: argument.proposal_id,
      citizen_id: argument.citizen_id,
    });
    bumpAndMaybeTrigger(store.argumentCountsByProposal, argument.proposal_id);

    return argument;
  }

  function lockArgument(id: string): DeliberationArgument {
    const argument = store.argumentsById.get(id);
    if (!argument) throw notFound("argument not found");
    if (argument.stance !== "agreement") {
      throw validation("only agreement-stance arguments can be locked");
    }
    argument.locked = true;
    return argument;
  }

  function listArgumentsByProposal(proposalId: string): DeliberationArgument[] {
    return [...store.argumentsById.values()]
      .filter((argument) => argument.proposal_id === proposalId)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  function declarePreference(input: DeclarePreferenceInput): Preference {
    const preference: Preference = {
      id: randomUUID(),
      problem_id: input.problem_id,
      citizen_id: input.citizen_id,
      description: input.description,
      created_at: new Date(),
    };
    store.preferencesById.set(preference.id, preference);
    bumpAndMaybeTrigger(store.preferenceCountsByProblem, preference.problem_id);

    return preference;
  }

  function listPreferencesByProblem(problemId: string): Preference[] {
    return [...store.preferencesById.values()]
      .filter((preference) => preference.problem_id === problemId)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  return {
    postArgument,
    lockArgument,
    listArgumentsByProposal,
    declarePreference,
    listPreferencesByProblem,
  };
}

export type DeliberationService = ReturnType<typeof createDeliberationService>;
