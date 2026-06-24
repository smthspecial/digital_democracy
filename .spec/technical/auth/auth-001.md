---
id: AUTH-001
type: auth-spec
title: "citizen"
status: draft
layer: citizen
linkedIds: FR-001,FR-003,FR-004,FR-015,FR-017,FR-020,FR-028,FR-030,FR-038,FR-056,AUTH-010,ADR-014
created: 2026-06-18
---

## Description

Base role held by every active, verified civic identity. The citizen role is the foundation of political authority in the system. All other roles are additive extensions; every holder of a higher role is also a citizen.

This is the only role granted automatically — every registered and verified person is a citizen. No appointment, election, or assignment is required.

## Acquisition

Automatic upon successful identity verification (SRV-001, DP-002). Requires exactly one active `citizen` record with `status=active` and at least one `identity_verification` record with `status=verified`. No other action is needed; the citizen role and its full permission set are active from that moment.

## Fine-grained permissions

Full permission definitions (action, scope, conditions, MFA tier) are specified in AUTH-010. Summary:

| Permission ID | Action | Scope | MFA tier |
|--------------|--------|-------|----------|
| `problem:create` | Submit a problem | any | T2 |
| `problem:endorse` | Endorse a problem | jurisdiction:member | T2 |
| `proposal:create` | Create a proposal | any | T2 |
| `proposal:constraint:add` | Add constraint to own proposal | proposal:author | T2 |
| `proposal:budget:add` | Add budget to own proposal | proposal:author | T2 |
| `scope_challenge:file` | File a scope challenge | jurisdiction:affected | T2 |
| `argument:post` | Post a deliberation argument | any | T2 |
| `preference:declare` | Declare preference | any | T2 |
| `ballot:cast` | Cast a ballot | session:issued | T3 |
| `ballot:verify` | Verify ballot inclusion | any | T1 |
| `delegation:create` | Create a delegation | any | T2 |
| `delegation:revoke` | Revoke own delegation | own | T2 |
| `budget:vote` | Submit budget allocation | any | T2 |
| `competency:apply` | Apply for domain competency | any | T2 |
| `competency_challenge:submit` | Submit a competency challenge | any | T2 |
| `coi:declare` | Declare conflict of interest | own | T2 |
| `assignment:accept` | Accept a civic assignment | assigned | T2 |
| `assignment:abandon` | Abandon a civic assignment | assigned | T2 |
| `audit_log:read` | Read the public audit log | any | T1 |
| `governance_data:read` | View all public governance data | any | T1 |
| `education:access` | Access civic education materials | any | T1 |

## Restrictions

- Voting weight is identical for all citizens regardless of wealth, education, profession, or credentials (FR-020).
- Participation score and reputation never alter voting weight (FR-027, FR-052).
- A citizen cannot unilaterally revoke another citizen's identity (FR-007).
- Ballot choice is secret and cannot be linked to the citizen's identity (FR-003, ADR-002).

## Loss / suspension

- `citizen.status=suspended` — citizen cannot participate; all capabilities paused. Requires multi-approval (DP-035, FR-007).
- `citizen.status=revoked` — permanent removal; triggers DP-042 cascade.
- Stage 3 inactivity (`participation_record.inactivity_stage=3`) — advanced governance privileges paused; constitutional protections and information access retained (FR-054).
