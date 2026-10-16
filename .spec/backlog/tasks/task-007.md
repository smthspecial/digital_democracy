---
id: TASK-007
type: task
title: "Select and review the complete anonymous voting protocol"
status: in-progress
storyId: US-002
priority: high
dependsOn: TASK-006
linkedIds: REL-002,ADR-002,ADR-006,NFR-001,NFR-003,FR-003,FR-004,SRV-008,ADR-042
created: 2026-10-08
---

## Outcome

An accepted design defines the complete election protocol and its integration boundaries before cryptographic implementation.

## Responsible role

Cryptography engineer and independent election-security reviewer. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Evaluate reviewed implementations against all required voting methods, eligibility, end-to-end verifiability, receipt-freeness and coercion resistance. Document maintenance, licensing and independent review evidence.
- [ ] Threat-model compromised clients/operators, colluding trustees, stolen credentials, metadata correlation, replay, malformed proofs and coercers. Specify explicit security assumptions; encryption alone is not an acceptance result.
- [ ] Prototype one encrypted election with real proof verification and threshold decryption. Identify unsupported requirements; keep production casting disabled if no candidate meets them.
- [ ] Publish a new ADR with protocol/version, anonymous submission design, election manifest/options binding, credential spending, key threshold, public artifacts, tally method and voter verification behavior.
- [ ] Obtain independent design review and address blocking findings. Reuse reviewed cryptographic components rather than inventing primitives; estimate downstream work from the prototype.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.

## Implementation checkpoint — 2026-10-08

See [implementation evidence](../../../testing/production-readiness/README.md)
for executed controls and the remaining acceptance gates. Local fixture results
do not qualify a production target.

## Local credential feasibility — 2026-10-14

The [isolated blind-credential experiment](../../../testing/cryptography/README.md)
uses pinned CIRCL v1.6.5 / RFC 9474 with synthetic citizens and ephemeral keys.
It exercises real blinding, signing, unblinding and independent standard-library
RSA-PSS verification; negative cases cover tampering, cross-election signing,
duplicate issuance and local concurrent spending. The upstream signature suite
and RFC vectors run alongside it. Exact evidence and limitations are retained
in [results](../../../testing/cryptography/results.json).

This advances the protocol experiment only. Policy/storage are in-memory, no
application route or production dependency changed, and bearer transferability
is explicitly demonstrated. TASK-008 remains pending; receipt-freeness, all
voting methods, durable integration and independent review remain open.
The [assessment](../../../testing/production-readiness/cryptography-assessment.md)
now distinguishes BeleniosRF's receipt-freeness research from Belenios and records
published VoteAgain criticisms. No candidate or trustee threshold is approved.
