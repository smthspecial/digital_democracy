---
id: AUTH-008
type: auth-spec
title: "protocol_council"
status: draft
layer: protocol
linkedIds: FR-059,FR-061,FR-062,FR-063,FR-065,FR-067,ADR-001,ADR-011
created: 2026-06-18
---

## Description

The protocol layer role. Protocol council members may propose changes to voting logic, identity rules, jurisdiction logic, and proposal lifecycle rules. Every protocol change requires citizen supermajority approval, independent audit confirmation, a mandatory time delay with public visibility, and multi-body endorsement before activation (FR-067, ADR-001, ADR-011). No protocol council member can activate a change unilaterally.

## Acquisition

Elected by citizen supermajority vote through a standard vote session (SRV-008). The election itself must be audited and certified. Term-limited (FR-062). Candidates must disclose all conflicts of interest (FR-063).

## Capabilities

| Capability | Condition | FR |
|-----------|-----------|-----|
| Propose protocol changes (voting logic, identity rules, lifecycle rules) | Active governance_role (type=protocol_council), within term | FR-067 |
| Submit approval for multi-approval coordination | Active term | FR-061 |
| Initiate delayed execution request | All approvals obtained + delay elapsed | FR-065, FR-067 |

## Restrictions

- Cannot activate a protocol change unilaterally. All three approval types (`citizen_supermajority`, `audit_confirmation`, `body_endorsement`) must be independently satisfied (FR-061, FR-067).
- Cannot modify individual votes, citizen identities, or specific governance decisions. Authority is limited to rule definitions, not rule application outcomes.
- Cannot modify implementation layer infrastructure directly. Operators are independent (ARCH-003).
- Time-delay enforcement (FR-065): a protocol change is publicly visible and challengeable during the delay window. Execution is blocked until `DP-043` confirms the delay has elapsed without a successful block.
- COI exclusion: a member with a conflict in the affected domain of a proposed rule change is excluded from the multi-approval vote for that change (FR-063).
- All proposals and activation events are written to the audit log (DP-036).

## Term and rotation

- Term-limited with mandatory rotation. DP-050 enforces expiry. No permanent protocol authority (FR-062, ADR-009).
