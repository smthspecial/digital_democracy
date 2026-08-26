import type {
  ExpertDomain,
  Competency,
  ConflictOfInterest,
  ExpertAssessment,
  CompetencyChallenge,
} from "./domain/types.js";

export interface Store {
  domains: Map<string, ExpertDomain>;
  competencies: Map<string, Competency>;
  conflicts: Map<string, ConflictOfInterest>;
  assessments: Map<string, ExpertAssessment>;
  challenges: Map<string, CompetencyChallenge>;
}

export function createStore(): Store {
  return {
    domains: new Map(),
    competencies: new Map(),
    conflicts: new Map(),
    assessments: new Map(),
    challenges: new Map(),
  };
}
