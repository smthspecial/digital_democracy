---
id: TASK-011
type: task
title: "Replace placeholder counting with verifiable encrypted election tallying"
status: todo
storyId: US-002
priority: high
dependsOn: TASK-009,TASK-010
linkedIds: REL-002,US-032,US-034,FR-004,FR-014,FR-042,NFR-003,SRV-008
created: 2026-10-08
---

## Outcome

Closed elections produce method-correct tallies and public evidence that an independent verifier can reproduce.

## Responsible role

Voting/backend engineer and verifier engineer. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Use the selected protocol aggregation/mix/decryption flow and valid trustee shares. Remove plaintext-option counting from the production encrypted-ballot path.
- [ ] Cover required ranked, approval, preference-score and comparative methods, ties, participation/quorum and decision thresholds; bind certification to the immutable manifest and verified tally.
- [ ] Use durable distributed locks/idempotency so replica/restart/concurrent tally requests cannot certify different outcomes.
- [ ] Publish minimal public ballot/tally proofs and inclusion artifacts; provide an independent verifier and voter inclusion flow satisfying receipt-freeness requirements.
- [ ] Tampered artifacts, missing shares, invalid proofs and incorrect totals block certification. Verify crash recovery and audit events without identity/choice leakage.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.
