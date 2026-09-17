export type DeliberationStance = "agreement" | "disagreement";

export interface DeliberationArgument {
  id: string;
  proposalId: string;
  authorId: string;
  parentId: string | null;
  stance: DeliberationStance;
  body: string;
  evidenceRef: string;
  createdAt: Date;
  locked: boolean;
  lockedAt: Date | null;
}

export interface Preference {
  id: string;
  citizenId: string;
  problemId: string;
  desiredOutcome: string;
  createdAt: Date;
}

export interface PostArgumentInput {
  proposalId: string;
  authorId: string;
  parentId?: string;
  stance: DeliberationStance;
  body: string;
  evidenceRef: string;
}

export interface DeclarePreferenceInput {
  citizenId: string;
  problemId: string;
  desiredOutcome: string;
}

export interface ArgumentListFilter {
  proposalId?: string;
}

export interface PreferenceListFilter {
  problemId?: string;
}
