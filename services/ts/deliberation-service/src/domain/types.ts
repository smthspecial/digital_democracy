export type Stance = "agreement" | "disagreement";

export interface DeliberationArgument {
  id: string;
  proposal_id: string;
  citizen_id: string;
  parent_id: string | null;
  content: string;
  evidence_ref: string;
  stance: Stance;
  locked: boolean;
  created_at: Date;
}

// TBL-018's `desired_outcome` column is exposed on the wire as `description`.
export interface Preference {
  id: string;
  problem_id: string;
  citizen_id: string;
  description: string;
  created_at: Date;
}
