export type JurisdictionScopeLevel =
  | "property"
  | "street"
  | "municipality"
  | "regional"
  | "national"
  | "constitutional";

export type JurisdictionStatus = "active" | "under_review";

export interface Jurisdiction {
  id: string;
  parentId: string | null;
  name: string;
  scopeLevel: JurisdictionScopeLevel;
  boundaryRef: string;
  status: JurisdictionStatus;
  minResidencyDays: number;
  population: number | null;
  supportRateBps: number;
  minThreshold: number;
  maxThreshold: number | null;
}

// SRV-002's "Read jurisdiction tree" sync read -- assembled in-process by
// JurisdictionService, never persisted as its own row.
export interface JurisdictionNode extends Jurisdiction {
  children: JurisdictionNode[];
}

export type ResidencyStatus = "active" | "ended";

export interface Residency {
  id: string;
  citizenId: string;
  jurisdictionId: string;
  startDate: Date;
  verified: boolean;
  status: ResidencyStatus;
}

export interface JurisdictionMembership {
  id: string;
  citizenId: string;
  jurisdictionId: string;
  createdAt: Date;
}
