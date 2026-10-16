import { Injectable, ServiceUnavailableException } from "@nestjs/common";

export interface CertifiedSession {
  id: string;
  proposal_id: string;
  jurisdiction_id: string;
  status: string;
  tally_result?: {
    vote_session_id: string;
    winner?: string;
    decided: boolean;
    total_ballots: number;
  };
}
export interface VoteOption {
  id: string;
  vote_session_id: string;
  proposal_id: string;
}

@Injectable()
export class VotingRuntime {
  async get<T>(path: string): Promise<T> {
    const base = process.env.VOTING_SERVICE_URL;
    if (!base)
      throw new ServiceUnavailableException("Voting service is not configured");
    try {
      const response = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Voting read failed");
      return (await response.json()) as T;
    } catch {
      throw new ServiceUnavailableException(
        "Authoritative voting result unavailable",
      );
    }
  }
}
