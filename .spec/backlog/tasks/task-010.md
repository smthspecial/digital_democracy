---
id: TASK-010
type: task
title: "Integrate client encryption and cryptographic ballot proof validation"
status: todo
storyId: US-002
priority: high
dependsOn: TASK-007,TASK-008,TASK-009
linkedIds: REL-002,BUG-005,FR-003,FR-004,NFR-001,SRV-008
created: 2026-10-08
---

## Outcome

Real clients produce protocol-valid encrypted ballots that the runtime verifies without learning identity or choice.

## Responsible role

Frontend and voting/backend engineers. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Publish/fetch authenticated election manifests, frozen options and public keys; implement the chosen encoding and encryption in the supported web/mobile clients.
- [ ] Provide a real BALLOT_VERIFIER_URL component or the reviewed local integration selected in TASK-007. It receives only election-bound ciphertext/proof; enforce workload policy/TLS and bounded responses.
- [ ] Validate proof, election context, allowed choices and encoding; reject malformed, wrong-election, replayed and out-of-set ballots before storage.
- [ ] Keep missing/unhealthy verifier behavior closed and return actionable citizen errors without leaking ballot data.
- [ ] Exercise real encryption/proofs end to end through HTTP and Postgres. Positive controls use the actual cryptographic implementation; include physical/platform-passkey checks for the citizen authentication path.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.
