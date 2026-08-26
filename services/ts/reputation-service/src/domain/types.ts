export type PositiveFactorType =
  | "accurate_prediction"
  | "constructive"
  | "disclosure"
  | "successful_proposal";

export type NegativeFactorType =
  | "misinformation"
  | "undisclosed_conflict"
  | "manipulation"
  | "fraud";

export type FactorType = PositiveFactorType | NegativeFactorType;

export type Polarity = "positive" | "negative";

export const FACTOR_POLARITY: Record<FactorType, Polarity> = {
  accurate_prediction: "positive",
  constructive: "positive",
  disclosure: "positive",
  successful_proposal: "positive",
  misinformation: "negative",
  undisclosed_conflict: "negative",
  manipulation: "negative",
  fraud: "negative",
};

export const FACTOR_TYPES = Object.keys(FACTOR_POLARITY) as FactorType[];

// DP-039: a delta of this magnitude or larger is dispatched to notification-service.
export const SIGNIFICANT_DELTA_THRESHOLD = 10;

export interface ReputationRecord {
  id: string;
  citizenId: string;
  factorType: FactorType;
  delta: number;
  sourceRef: string | null;
  createdAt: Date;
}
