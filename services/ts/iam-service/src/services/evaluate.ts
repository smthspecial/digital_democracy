// DP-071 / ARCH-024 §4: POST /iam/evaluate's algorithm. Deliberately NOT
// audited -- read-path traffic, unlike propose/endorse/revoke (DP-071's own
// doc, srv-018.md's Key rules) -- so there is no AuditEmitter parameter
// here at all, unlike policies.ts/attachments.ts.
import type { GovernanceRoleChecker } from "../collaborators.js";
import type { RoleType } from "../domain/types.js";
import type { Store } from "../store.js";

export interface EvaluateAccessRequest {
  principalRef: string;
  action: string;
  resource: string;
  context?: Record<string, unknown>;
}

export interface EvaluateAccessResult {
  effect: "allow" | "deny";
  matchedPolicyId: string | null;
}

const CITIZEN_REF_PREFIX = "citizen:";
const ROLE_REF_PREFIX = "role:";

// A trailing '*' matches by prefix (e.g. 'secrets:*' matches
// 'secrets:rotate'); anything else must match exactly (ARCH-024 §4 step 2).
function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern,
  );
}

function conditionsMatch(
  conditions: Record<string, unknown> | null,
  context: Record<string, unknown> | undefined,
): boolean {
  if (conditions === null) return true;
  const ctx = context ?? {};
  return Object.entries(conditions).every(([key, value]) => ctx[key] === value);
}

// ARCH-024 §4 step 1: an attachment applies to this request if its
// principal_ref is the request's principal_ref verbatim, OR is
// 'role:<roleType>' for a role_type the request's principal (parsed out of
// a 'citizen:<uuid>' principal_ref) currently, actively holds -- resolved
// live against governance-role-service, never inferred locally.
async function attachmentApplies(
  governanceRoleChecker: GovernanceRoleChecker,
  requestPrincipalRef: string,
  attachmentPrincipalRef: string,
  roleCache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (attachmentPrincipalRef === requestPrincipalRef) return true;

  if (!attachmentPrincipalRef.startsWith(ROLE_REF_PREFIX)) return false;
  if (!requestPrincipalRef.startsWith(CITIZEN_REF_PREFIX)) return false;

  const citizenId = requestPrincipalRef.slice(CITIZEN_REF_PREFIX.length);
  const roleType = attachmentPrincipalRef.slice(ROLE_REF_PREFIX.length) as RoleType;

  const cacheKey = `${citizenId}:${roleType}`;
  let pending = roleCache.get(cacheKey);
  if (!pending) {
    pending = Promise.resolve(governanceRoleChecker.hasActiveRole(citizenId, roleType));
    roleCache.set(cacheKey, pending);
  }
  return pending;
}

// ARCH-024 §4 steps 3-5: explicit deny anywhere wins over any allow; no
// match at all is deny (default deny).
export async function evaluateAccess(
  store: Store,
  governanceRoleChecker: GovernanceRoleChecker,
  request: EvaluateAccessRequest,
): Promise<EvaluateAccessResult> {
  const roleCache = new Map<string, Promise<boolean>>();
  let allowMatch: string | null = null;

  for (const attachment of store.listAttachments()) {
    if (attachment.status !== "active") continue;
    if (!(await attachmentApplies(governanceRoleChecker, request.principalRef, attachment.principalRef, roleCache))) {
      continue;
    }

    const policy = store.getPolicy(attachment.policyId);
    if (!policy || policy.status !== "active") continue;

    if (!matchesAny(request.action, policy.actions)) continue;
    if (!matchesAny(request.resource, policy.resources)) continue;
    if (!conditionsMatch(policy.conditions, request.context)) continue;

    if (policy.effect === "deny") {
      return { effect: "deny", matchedPolicyId: policy.id };
    }
    if (allowMatch === null) {
      allowMatch = policy.id;
    }
  }

  if (allowMatch !== null) {
    return { effect: "allow", matchedPolicyId: allowMatch };
  }
  return { effect: "deny", matchedPolicyId: null };
}
