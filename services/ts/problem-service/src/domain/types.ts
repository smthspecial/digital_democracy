export type ProblemStatus = "open" | "proposing" | "closed";

export interface Problem {
  id: string;
  citizenId: string;
  title: string;
  description: string;
  affectedArea: string;
  candidateScope: string;
  status: ProblemStatus;
  createdAt: Date;
}

export interface ProblemSupport {
  id: string;
  problemId: string;
  citizenId: string;
  createdAt: Date;
}

export interface SubmitProblemInput {
  citizenId: string;
  title: string;
  description: string;
  affectedArea: string;
  candidateScope: string;
}
