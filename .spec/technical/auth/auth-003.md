---
id: AUTH-003
type: auth-spec
title: "auditor"
status: draft
layer: audit
linkedIds: FR-055,FR-062,FR-063,FR-066,ADR-009
created: 2026-06-18
---

## Description

A citizen randomly selected into a time-limited audit role. Auditors observe, verify, and report on budget consumption, project implementation, and outcome evaluation. They cannot execute decisions or approve protocol changes. Multiple independent audit bodies operate concurrently to prevent single-point oversight failure (FR-066).

## Acquisition

Randomized selection (FR-062). Citizens cannot self-nominate. The civic-duty-service (SRV-009) generates audit pool assignments via DP-054. `governance_role.randomized=true` for all auditor records. Domain contributors may be added as supporting participants (FR-055) within the same assignment without holding the auditor role.

## Capabilities (additive over AUTH-001)

| Capability | Condition | FR |
|-----------|-----------|-----|
| Access audit pool civic assignments | Active governance_role (type=auditor, within term) | FR-055 |
| Review budget consumption and project spend | Active term, within assigned scope | FR-055 |
| Verify project milestone completion | Active term, within assigned scope | FR-046, FR-055 |
| Submit outcome evaluation | Active term, assigned to evaluation task | FR-048 |
| Publish audit findings (public) | Active term | FR-055 |
| Cross-validate findings with other audit bodies | Active term | FR-066 |

## Restrictions

- Cannot execute any implementation decision (FR-045).
- Cannot approve or block protocol changes (FR-067).
- Cannot write to the audit log directly; all audit events flow through the `audit-service` (SRV-012).
- Cannot hold the role beyond `term_end` (FR-062). No renewal as the same individual immediately after term end.
- Excluded from audit assignments where a COI exists (FR-063, DP-033).

## Term and rotation

- Term bounds: `governance_role.term_start` and `term_end`. DP-050 enforces rotation.
- On `term_end`, assignment is released; DP-040 generates a new randomized selection from the eligible citizen pool.
