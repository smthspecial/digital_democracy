---
id: AUTH-002
type: auth-spec
title: "expert (domain contributor)"
status: draft
layer: citizen
linkedIds: FR-020,FR-021,FR-022,FR-023,FR-024,FR-025,FR-026,FR-056
created: 2026-06-18
---

## Description

A citizen who holds active competency in one or more domains. Domain expertise grants enhanced visibility and advisory publishing rights within the relevant domain(s) only. It confers no additional voting weight and no authority to override citizen decisions.

## Acquisition

Automatic when `competency.status=active` for a given `(citizen_id, domain_id)` pair. Requires successful completion of the five-stage competency acquisition pipeline (DP-031, FR-022). Competency is domain-specific and non-transferable.

## Capabilities (additive over AUTH-001)

| Capability | Condition | FR |
|-----------|-----------|-----|
| Publish expert assessment on a proposal | Active competency in proposal's domain, no undisclosed COI | FR-023 |
| Receive enhanced visibility on arguments | Active competency in domain, argument in that domain | FR-023 |
| Support competency challenge reviews (advisory) | Active competency in the challenged citizen's domain | FR-024 |
| Receive domain delegation from other citizens | Active competency in the delegated domain | FR-056 |
| Appear in civic assignment weighting for domain tasks | Active competency | FR-050 |

## Restrictions

- Cannot veto proposals, override votes, block voting, or create binding decisions (FR-023).
- Expert warnings never prevent a vote from proceeding (FR-023, ADR-007).
- Cannot suppress opposing opinions (FR-023).
- Competency in domain A does not confer any rights in domain B (FR-021).
- Must disclose all relevant conflicts of interest before participating in domain work (FR-025). Undisclosed COI is grounds for competency challenge and negative reputation delta.
- Authority is scoped strictly to the domain in which competency is held.

## Expiry and revocation

- `competency.status` transitions to `expired` when `expires_at` is passed (DP-044, FR-026). Re-validation required to restore status.
- `competency.status` transitions to `revoked` if a competency challenge is upheld (DP-032, FR-024).
- Inactivity in the domain contributes to expiry at renewal time (FR-026).
