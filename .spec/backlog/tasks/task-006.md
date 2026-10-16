---
id: TASK-006
type: task
title: "Confirm deployment inputs and production release scope"
status: in-progress
storyId: US-057
priority: high
linkedIds: REL-002,ADR-026,ADR-041,US-052,US-053,US-056,US-058,BUG-020
created: 2026-10-08
---

## Outcome

Produce a checked environment inventory and a release scope that can be provisioned and tested.

## Responsible role

Platform lead with product and security owners. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Record staging/production cluster contexts, nodes, storage, network-policy support, domain/DNS control, image registry, gateway and verifier service accounts. Use the existing self-hosted k3s baseline; no managed-service purchase is assumed.
- [ ] Name independent election trustees, protocol reviewer, deployment owner and incident contact; credentials stay outside the specification.
- [ ] Inventory existing databases, audit history/signing keys, backups, client/verifier versions and whether real votes or citizens already exist.
- [ ] Set the intended election methods, electorate/load and recovery targets. National deployment retains NFR-009 and US-052/US-053 requirements; a single-node staging success does not satisfy them.
- [ ] Record unresolved inputs with an owner and required decision point. Publish an implementation estimate after TASK-007 feasibility work; do not invent a production date.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.

## Implementation checkpoint — 2026-10-08

See [implementation evidence](../../../testing/production-readiness/README.md)
for executed controls and the remaining acceptance gates. Local fixture results
do not qualify a production target.

## Current scope — 2026-10-10

The user selected local development for now and works alone. Use the existing
Compose architecture and one contributor for local operations. Separate people,
production cluster/domain/registry and real trustee custody are not prerequisites
for this local workflow. Preserve their existing production acceptance gates
for a future promotion. See BUG-020 and the root README for local startup.
