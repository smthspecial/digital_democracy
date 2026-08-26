export const SCOPE_LEVELS = ["neighborhood", "city", "region", "national"] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

export type JurisdictionStatus = "active" | "under_review";

export interface Jurisdiction {
  id: string;
  parent_id: string | null;
  name: string;
  scope_level: ScopeLevel;
  boundary_ref: string;
  status: JurisdictionStatus;
}

export type ResidencyStatus = "active" | "ended";

export interface Residency {
  id: string;
  citizen_id: string;
  jurisdiction_id: string;
  start_date: Date;
  end_date: Date | null;
  verified: boolean;
  status: ResidencyStatus;
}

export interface Membership {
  id: string;
  citizen_id: string;
  jurisdiction_id: string;
  created_at: Date;
}
