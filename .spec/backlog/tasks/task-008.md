---
id: TASK-008
type: task
title: "Implement unlinkable one-time election credentials"
status: todo
storyId: US-002
priority: high
dependsOn: TASK-007
linkedIds: REL-002,TASK-005,FR-003,FR-041,NFR-001,TBL-021,TBL-022
created: 2026-10-08
---

## Outcome

Eligible citizens obtain one election-bound credential whose presentation cannot be joined to their identity.

## Responsible role

Voting/backend engineer. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Reuse the authoritative jurisdiction roster and one-issuance-per-citizen rule; apply the selected blind/anonymous credential protocol.
- [ ] Separate identity-authenticated issuance from anonymous credential redemption as specified by TASK-007. Define spending storage and its atomicity with durable ballot writes.
- [ ] Reject forged credentials, wrong-election use and duplicate spending under concurrent requests and multiple replicas.
- [ ] Remove joinable credential identifiers from ballot records, API responses, audit events, logs and traces; document timing/metadata protections.
- [ ] Real database tests cover issuance/retry, eligibility changes, crash recovery and spend races. Existing random bearer tokens must not be relabeled as blind signatures.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.
