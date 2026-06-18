---
id: AUTH-001
type: auth-spec
title: "citizen"
status: draft
layer: citizen
linkedIds: FR-001,FR-003,FR-004,FR-015,FR-017,FR-020,FR-028,FR-030,FR-038,FR-056
created: 2026-06-18
---

## Description

Base role held by every active, verified civic identity. The citizen role is the foundation of political authority in the system. All other roles are additive extensions; every holder of a higher role is also a citizen.

## Acquisition

Automatic upon successful identity verification (SRV-001, DP-002). Requires exactly one active `citizen` record with `status=active` and at least one `identity_verification` record with `status=verified`.

## Capabilities

| Capability | Condition | FR |
|-----------|-----------|-----|
| Submit a problem | Active identity | FR-015 |
| Endorse a problem | Active identity, member of affected jurisdiction | FR-016 |
| Create a proposal | Active identity | FR-017, FR-018 |
| Add proposal constraints / budget | Active identity, proposal author | FR-029, FR-037 |
| Post deliberation argument | Active identity | FR-028 |
| Declare preference | Active identity | FR-030 |
| Submit budget allocation vote | Active identity | FR-038 |
| Cast ballot | Active identity, eligibility token issued for session | FR-003 |
| Verify own ballot inclusion | Holder of verification_code | FR-004 |
| Create / revoke delegation | Active identity | FR-056, FR-057 |
| File scope challenge | Active identity | FR-010 |
| Submit competency challenge (with evidence) | Active identity | FR-024 |
| View all public governance data | Active identity | FR-009, FR-036, FR-047 |
| Access civic education materials | Active identity | FR-049 |

## Restrictions

- Voting weight is identical for all citizens regardless of wealth, education, profession, or credentials (FR-020).
- Participation score and reputation never alter voting weight (FR-027, FR-052).
- A citizen cannot unilaterally revoke another citizen's identity (FR-007).
- Ballot choice is secret and cannot be linked to the citizen's identity (FR-003, ADR-002).

## Loss / suspension

- `citizen.status=suspended` — citizen cannot participate; all capabilities paused. Requires multi-approval (DP-035, FR-007).
- `citizen.status=revoked` — permanent removal; triggers DP-042 cascade.
- Stage 3 inactivity (`participation_record.inactivity_stage=3`) — advanced governance privileges paused; constitutional protections and information access retained (FR-054).
