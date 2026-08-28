// FR-014/TBL-003's six impact-scope levels, smallest to largest. Order
// matters only as documentation here today -- no escalation logic reads it
// (see EPIC-002's "escalate only when a problem exceeds local scope",
// which isn't implemented against this ordering yet).
export const SCOPE_LEVELS = [
  "property",
  "street",
  "municipality",
  "regional",
  "national",
  "constitutional",
] as const;
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
