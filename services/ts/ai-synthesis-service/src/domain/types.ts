export type Stance = "agreement" | "disagreement";

export interface ArgumentInput {
  content: string;
  stance: Stance;
  evidence_ref?: string;
}

export interface PreferenceInput {
  description: string;
}

export interface ArgumentWithId extends ArgumentInput {
  id: string;
}

export interface SharedObjective {
  description: string;
  count: number;
}

export interface Conflict {
  argument_id_a: string;
  argument_id_b: string;
  overlapping_terms: string[];
}

export interface AlternativeFraming {
  stance: Stance;
  framing: string;
}

export interface TradeoffSignal {
  keyword: string;
  frequency: number;
}

export interface FlagReason {
  citizen_id: string;
  reason: string;
  flagged_at: Date;
}

export interface ModelProvenance {
  model_name: string;
  version: string;
  training_data_summary: string;
}

export interface SynthesisAnalysis {
  arguments: ArgumentWithId[];
  shared_objectives: SharedObjective[];
  conflicts: Conflict[];
  alternative_framings: AlternativeFraming[];
  tradeoffs: TradeoffSignal[];
}

export interface SynthesisOutput extends SynthesisAnalysis {
  id: string;
  proposal_id: string;
  created_at: Date;
  flagged: boolean;
  flag_reasons: FlagReason[];
  label: string;
  model_provenance: ModelProvenance;
}
