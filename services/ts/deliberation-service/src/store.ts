import type { DeliberationArgument, Preference } from "./domain/types.js";

export interface Store {
  argumentsById: Map<string, DeliberationArgument>;
  preferencesById: Map<string, Preference>;
  argumentCountsByProposal: Map<string, number>;
  preferenceCountsByProblem: Map<string, number>;
}

export function createStore(): Store {
  return {
    argumentsById: new Map(),
    preferencesById: new Map(),
    argumentCountsByProposal: new Map(),
    preferenceCountsByProblem: new Map(),
  };
}
