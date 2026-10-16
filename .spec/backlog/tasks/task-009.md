---
id: TASK-009
type: task
title: "Implement trustee key ceremonies and verified threshold decryption"
status: todo
storyId: US-002
priority: high
dependsOn: TASK-007,TASK-006
linkedIds: REL-002,ADR-002,NFR-001,NFR-008,SRV-008
created: 2026-10-08
---

## Outcome

Election keys are established and used through the selected distributed protocol without a full private key available to one operator.

## Responsible role

Independent trustees with cryptography engineer. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Implement the chosen key ceremony, public election key and verifiable trustee contributions. Record threshold/holder independence and bind all material to the immutable election manifest.
- [ ] Protect each private share independently; deployment Secrets and application databases must not gather all shares in one control domain.
- [ ] Verify decryption shares and reject invalid or wrong-election contributions. Below-quorum access cannot decrypt; an authorized quorum can finish correctly.
- [ ] Rehearse unavailable trustees, loss/compromise recovery, retention/destruction and rotation between elections. The recovery process preserves required independence.
- [ ] Publish only public ceremony/verification artifacts and document operator instructions; prohibit plaintext vote/key-share logging.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.
