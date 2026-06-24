---
id: AUTH-010
type: auth-spec
title: "Fine-grained permission schema"
status: draft
linkedIds: AUTH-001,AUTH-002,AUTH-003,AUTH-004,AUTH-005,AUTH-006,AUTH-007,AUTH-008,AUTH-009,ADR-014
created: 2026-06-19
---

## Overview

This document defines the canonical permission model used by all services to enforce authorization. Every role (AUTH-001 through AUTH-008) is expressed as a set of permission records conforming to the schema below. Services evaluate permissions at request time — not at login — by checking the actor's active roles against the required permission for the requested operation.

---

## Permission struct

```
Permission {
  id:         string       # unique identifier, e.g. "problem:endorse"
  action:     string       # verb:resource — what the actor does
  scope:      ScopeType    # what resources the actor may target
  conditions: string[]     # runtime guards evaluated per request
  mfa_tier:   T1 | T2 | T3  # minimum assurance tier (ADR-014)
}
```

### Scope types

| Scope | Meaning |
|-------|---------|
| `any` | No resource restriction |
| `own` | `resource.owner_id = actor.citizen_id` |
| `jurisdiction:member` | Actor is a member of the resource's jurisdiction |
| `jurisdiction:affected` | Actor is in the affected jurisdiction of the resource |
| `proposal:author` | Actor is the proposal's `author_id` |
| `domain:match` | Actor has active `competency` in the resource's domain |
| `session:issued` | Actor has an unused `eligibility_token` for this vote session |
| `assigned` | Actor has an active `civic_assignment` whose `target_ref` matches the resource |

### Condition tokens

| Token | Meaning |
|-------|---------|
| `citizen.active` | `citizen.status = active` |
| `competency.active` | `competency.status = active AND domain = target.domain` |
| `coi.none` | No active `conflict_of_interest` in the relevant domain |
| `role.term` | `governance_role.term_start ≤ now() ≤ term_end` |
| `token.unused` | `eligibility_token.used = false` |
| `unique:(citizen,resource)` | No prior record with the same `(citizen_id, resource_id)` |
| `evidence.required` | Request must include a non-null `evidence_ref` |
| `proposal.status:{list}` | `proposal.status` is one of the listed values |
| `totals:100` | Submitted allocations sum to 100% |

---

## AUTH-001 — Citizen permissions

Granted automatically to every citizen with `status=active`. These are the baseline rights of political participation.

| Permission ID | Action | Scope | Conditions | MFA tier |
|--------------|--------|-------|------------|----------|
| `identity:read:own` | Read own civic identity | own | citizen.active | T1 |
| `problem:create` | Submit a problem | any | citizen.active | T2 |
| `problem:endorse` | Endorse a problem | jurisdiction:member | citizen.active, unique:(citizen,problem) | T2 |
| `proposal:create` | Create a proposal | any | citizen.active | T2 |
| `proposal:constraint:add` | Add constraint to a proposal | proposal:author | citizen.active, proposal.status:draft,gathering_support,development | T2 |
| `proposal:budget:add` | Add budget information to a proposal | proposal:author | citizen.active | T2 |
| `scope_challenge:file` | File a scope challenge | jurisdiction:affected | citizen.active | T2 |
| `argument:post` | Post a deliberation argument | any | citizen.active, evidence.required | T2 |
| `preference:declare` | Declare preference on a proposal | any | citizen.active | T2 |
| `ballot:cast` | Cast a ballot in a vote session | session:issued | citizen.active, token.unused | T3 |
| `ballot:verify` | Verify own ballot inclusion | any | — (verification_code only; no citizen auth required) | T1 |
| `delegation:create` | Create a delegation to an expert | any | citizen.active, competency.active (on delegate) | T2 |
| `delegation:revoke` | Revoke own delegation | own | citizen.active | T2 |
| `budget:vote` | Submit budget allocation vote | any | citizen.active, totals:100 | T2 |
| `competency:apply` | Apply for domain competency | any | citizen.active | T2 |
| `competency_challenge:submit` | Submit a competency challenge | any | citizen.active, evidence.required | T2 |
| `coi:declare` | Declare conflict of interest | own | citizen.active | T2 |
| `assignment:accept` | Accept a civic assignment | assigned | citizen.active | T2 |
| `assignment:abandon` | Abandon a civic assignment | assigned | citizen.active | T2 |
| `exemption:claim` | Claim assignment exemption | own | citizen.active | T2 |
| `audit_log:read` | Read the public audit log | any | — | T1 |
| `education:access` | Access civic education materials | any | citizen.active | T1 |
| `governance_data:read` | View all public governance data | any | — | T1 |

---

## AUTH-002 — Expert (domain contributor) permissions

Additive over AUTH-001. Effective only within the domain in which `competency.status=active`.

| Permission ID | Action | Scope | Conditions | MFA tier |
|--------------|--------|-------|------------|----------|
| `assessment:publish` | Publish expert assessment on a proposal | domain:match | competency.active, coi.none | T2 |
| `delegation:receive` | Appear as eligible delegate for domain votes | domain:match | competency.active | T1 |

---

## AUTH-003 — Auditor permissions

Additive over AUTH-001. Effective only within the audit body assignment and term.

| Permission ID | Action | Scope | Conditions | MFA tier |
|--------------|--------|-------|------------|----------|
| `audit_assignment:access` | Access audit pool civic assignments | assigned | role.term | T2 |
| `audit_finding:submit` | Submit an audit finding | assigned | role.term | T2 |
| `outcome_evaluation:submit` | Submit a project outcome evaluation | assigned | role.term | T2 |
| `budget_consumption:read` | Review budget consumption (non-public detail) | assigned | role.term | T2 |
| `audit_findings:cross_validate` | Cross-validate findings with other audit bodies | assigned | role.term | T2 |

---

## AUTH-004 — Reviewer permissions

Additive over AUTH-001. Scoped to the specific `civic_assignment.target_ref`.

| Permission ID | Action | Scope | Conditions | MFA tier |
|--------------|--------|-------|------------|----------|
| `review_finding:submit` | Submit review findings on an assigned proposal | assigned | role.term | T2 |
| `expertise_verification:participate` | Participate in expertise verification review | assigned | role.term | T2 |
| `budget_oversight:submit` | Submit budget oversight observations | assigned | role.term | T2 |

---

## AUTH-005 — Oversight permissions

Additive over AUTH-001. Scoped to the assigned project.

| Permission ID | Action | Scope | Conditions | MFA tier |
|--------------|--------|-------|------------|----------|
| `milestone_update:report` | Report project milestone updates | assigned | role.term | T2 |
| `outcome_evaluation:submit` | Submit outcome evaluation | assigned | role.term | T2 |
| `budget_deviation:flag` | Flag budget deviation for audit review | assigned | role.term | T2 |
| `project_details:read` | View non-public project implementation details | assigned | role.term | T2 |

---

## AUTH-006 — Operator permissions

Independent layer — not additive over citizen. Operator credentials are organizational, not civic.

| Permission ID | Action | Scope | Conditions | MFA tier |
|--------------|--------|-------|------------|----------|
| `ledger_entry:record` | Record a ledger entry | any | — | T3 |
| `milestone:report` | Report project milestone | assigned | — | T2 |
| `infrastructure:deploy` | Manage infrastructure deployment | any | — | T3 |
| `approval:submit:operator` | Submit operator approval in multi-approval flow | any | — | T3 |

---

## AUTH-007 — Review body permissions

Additive over AUTH-001. Scoped to the assigned dispute or review case.

| Permission ID | Action | Scope | Conditions | MFA tier |
|--------------|--------|-------|------------|----------|
| `scope_challenge:resolve` | Resolve a scope challenge | assigned | role.term, coi.none | T3 |
| `competency_appeal:decide` | Decide a competency appeal | assigned | role.term, coi.none, competency.active (where required) | T3 |
| `constitutional_review:decide` | Issue a constitutional review decision | assigned | role.term, coi.none | T3 |
| `deadlock:progress` | Progress a proposal through deadlock resolution | assigned | role.term | T3 |
| `dispute_evidence:read` | Access non-public dispute evidence | assigned | role.term | T2 |

---

## AUTH-008 — Protocol council permissions

| Permission ID | Action | Scope | Conditions | MFA tier |
|--------------|--------|-------|------------|----------|
| `protocol_change:propose` | Propose a protocol change | any | role.term, coi.none | T3 |
| `approval:submit:council` | Submit council approval in multi-approval flow | any | role.term, coi.none | T3 |
| `delayed_execution:initiate` | Initiate delayed execution after all approvals | any | role.term, all approvals obtained, delay elapsed | T3 |

---

## System-only permissions (no human role)

These actions are executed only by internal service workers or cron jobs. They cannot be claimed by any citizen or operator.

| Permission ID | Action | Executed by |
|--------------|--------|-------------|
| `protocol_change:activate` | Activate protocol change after delay | DP-043 worker |
| `vote_session:schedule` | Schedule a vote session | DP-046 cron |
| `vote_session:certify` | Certify a vote session result | DP-027 worker |
| `eligibility_token:issue` | Batch-issue eligibility tokens | DP-025 worker |
| `assignment:generate` | Generate civic assignments | DP-040 worker |
| `governance_role:expire` | Expire time-limited roles | DP-050 cron |
| `citizen:activate` | Transition citizen to active after verification | DP-002 worker |

---

## Enforcement contract

Every service must:
1. Resolve the actor's active roles from `TBL-032` (governance_role) and infer `AUTH-001` from `citizen.status=active`.
2. Find the required permission for the requested operation from this document.
3. Verify the actor holds a role that grants that permission.
4. Evaluate all listed conditions against the current request context.
5. Verify the session meets the required MFA tier (ADR-014) via auth-service.
6. On any failure, reject with a structured error (no leaking of which guard failed to unauthorized actors).

No service may implement ad hoc authorization logic outside this schema. If an operation is not listed here, it is denied by default.
