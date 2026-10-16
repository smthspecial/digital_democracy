---
id: TASK-021
type: task
title: "Rehearse production promotion rollback and operational handover"
status: todo
storyId: US-057
priority: high
dependsOn: TASK-020
linkedIds: REL-002,REL-001,US-056,US-058,ADR-041
created: 2026-10-08
---

## Outcome

A reviewed release bundle can be promoted and operated with a tested recovery path.

## Responsible role

Release owner with platform and audit owners. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Deliver the exact release manifests/digests, completed evidence matrix, approved cryptographic design/review, dependency exception register and completed credential/backup preparation.
- [ ] Rehearse deployment, maintenance cutover, verification and rollback/restore on staging; record checkpoints, decision owner and maximum interruption target.
- [ ] Document operator and trustee runbooks, certificate/secret rotation, audit-key continuity, monitoring and incident contacts. Critical voting/secrecy controls cannot be disabled by emergency operational shortcuts.
- [ ] Confirm REL-001 business-flow criteria and all production scope requirements are satisfied. An unmet secrecy/verifiability requirement or unverified infrastructure boundary prevents promotion.
- [ ] At the execution stage, obtain the intended production target and deployment authorization before changing it. After promotion, run read-only/synthetic agreed checks and attach observed results; no real-voter penetration probes.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.

## Implementation checkpoint — 2026-10-08

See [implementation evidence](../../../testing/production-readiness/README.md)
for executed controls and the remaining acceptance gates. Local fixture results
do not qualify a production target.
