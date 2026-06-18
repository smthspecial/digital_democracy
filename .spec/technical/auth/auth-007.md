---
id: AUTH-007
type: auth-spec
title: "review_body"
status: draft
layer: audit
linkedIds: FR-010,FR-011,FR-022,FR-024,FR-034,FR-058,FR-059,FR-062,FR-066
created: 2026-06-18
---

## Description

An independent body member assigned to resolve governance disputes: scope challenges, competency appeals, constitutional review decisions, and deadlock resolution stages. Review body decisions are public, reasoned, and auditable. Multiple independent bodies operate concurrently on different dispute types; they do not share membership (FR-066, FR-011).

## Acquisition

Selected through a combination of random selection and competency-weighted criteria by governance-role-service (SRV-011) via DP-035 / DP-040. Review body members are time-limited (FR-062). Domain expertise may be required for certain dispute types (e.g., competency appeal review requires domain expertise in the challenged domain).

## Capabilities (additive over AUTH-001)

| Capability | Condition | FR |
|-----------|-----------|-----|
| Resolve scope challenge | Active governance_role (type=review_body), assigned dispute | FR-010, FR-011 |
| Decide competency appeal | Active term, domain expertise match where required | FR-022, FR-024 |
| Issue constitutional review decision | Active term, assigned constitutional review | FR-058, FR-059 |
| Progress a proposal through deadlock resolution stages | Active term, assigned to deadlock stage | FR-034 |
| Access non-public evidence submitted for disputes | Active term, within assigned case | FR-024 |

## Restrictions

- Cannot block a vote unilaterally for any reason other than a `result=blocked` constitutional review finding (FR-023). Scope disputes may pause a vote session, but only within defined SLA (DP-058).
- Cannot modify proposals, arguments, or any governance record outside their dispute scope.
- COI exclusion is strict: a review body member with any conflict in the dispute domain is excluded (FR-063, DP-033).
- Decisions must include a public rationale (FR-011). Unexplained decisions are invalid.

## Term and rotation

- Time-limited (FR-062). Continuous rotation enforced by DP-050. No permanent review body membership.
