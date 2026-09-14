export type ProblemStatus = "open" | "proposing" | "closed";

export interface Problem {
  id: string;
  authorId: string;
  title: string;
  description: string;
  affectedArea: string;
  jurisdictionId: string;
  status: ProblemStatus;
  createdAt: Date;
}

export interface ProblemSupport {
  id: string;
  problemId: string;
  citizenId: string;
  createdAt: Date;
}

export interface CreateProblemInput {
  authorId: string;
  title: string;
  description: string;
  affectedArea: string;
  jurisdictionId: string;
}

export interface AddSupportInput {
  problemId: string;
  citizenId: string;
}
