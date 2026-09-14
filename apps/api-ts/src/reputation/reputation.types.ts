export type ReputationFactorType =
  | "accurate_prediction"
  | "constructive"
  | "disclosure"
  | "successful_proposal"
  | "misinformation"
  | "undisclosed_conflict"
  | "manipulation"
  | "fraud";

export interface ReputationRecord {
  id: string;
  citizenId: string;
  factorType: ReputationFactorType;
  delta: number;
  reason: string;
  createdAt: Date;
}

export interface RecordDeltaInput {
  citizenId: string;
  factorType: ReputationFactorType;
  delta: number;
  reason: string;
}

export interface ReputationRecordListFilter {
  citizenId?: string;
}
