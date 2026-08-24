---
id: AUTH-006
type: auth-spec
title: "operator"
status: draft
layer: implementation
linkedIds: FR-036,FR-046,FR-061,FR-067,ADR-001,AUTH-011
created: 2026-06-18
---

## Description

The implementation layer role. Operators run infrastructure: they record ledger entries, report milestones, and manage system deployment. They are explicitly prohibited from modifying governance rules, altering vote outcomes, changing identity logic, or overriding audits (ARCH-003, ADR-001, FR-067). Platform infrastructure -- Kubernetes clusters, secrets, and CI/CD systems -- is a separate credential, AUTH-011, so that no single actor holds both civic-ledger authority and cluster-admin authority (separation of duties, ADR-001).

## Acquisition

Appointed by protocol-layer decision (multi-approval required, FR-061). Operator credentials are tied to organizational identity, not a civic identity. All operator actions are attributed to their organizational role in the audit log.

## Capabilities

| Capability | Condition | FR |
|-----------|-----------|-----|
| Record ledger entry | Active operator credential | FR-036 |
| Report project milestone | Active operator credential, assigned project | FR-046 |
| Submit approval for infrastructure actions | Active operator credential, within operator scope | FR-061 |

## Restrictions

- Cannot modify voting logic, identity rules, jurisdiction definitions, or proposal lifecycle rules (FR-067).
- Cannot alter vote outcomes or tally results.
- Cannot override audit findings or suppress audit output.
- Cannot read ballot content (cryptographic separation; ADR-002).
- Cannot perform identity verification or revocation without multi-approval.
- All operator actions are logged in the audit log (DP-036). Absence of an audit entry for an executed action is detectable.
- Cannot hold any citizen governance role simultaneously (implementation layer is separated from citizen and audit layers, ADR-001).
- Cannot access Kubernetes clusters, secrets, or CI/CD systems directly -- see AUTH-011.
