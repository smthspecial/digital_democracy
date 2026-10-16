---
id: TASK-020
type: task
title: "Run staging penetration tests and enforce readiness evidence"
status: in-progress
storyId: US-057
priority: high
dependsOn: TASK-012,TASK-014,TASK-015,TASK-016,TASK-017,TASK-018,TASK-019
linkedIds: REL-002,TP-017,TP-015,TP-016,NFR-007,NFR-001,NFR-003
created: 2026-10-08
---

## Outcome

The exact staged release has passing functional/security evidence and no unresolved blocking findings.

## Responsible role

Security engineer with independent reviewer. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Run TP-017 in static-then-active order against only the designated synthetic staging environment, including real encrypted elections and live mesh/TLS denial cases.
- [ ] Repeat original attack regressions, assurance/ownership/passkey checks, approval independence/delay, broker ACLs, database isolation and cross-replica replay attacks.
- [ ] Run real positive controls through the public gateway, both runtimes, verifiers, databases and broker; inspect logs/metrics/public artifacts for identity/choice leakage.
- [ ] Create tickets for findings, fix and retest them, and attach evidence to immutable image/schema/config versions. Preserve raw scan exceptions and reviewer conclusions.
- [ ] Require a healthy staging soak covering certificate renewal/restarts and representative load; define the duration and thresholds from TASK-006. Publish go/no-go criteria without claiming untested properties.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.

## Implementation checkpoint — 2026-10-08

See [implementation evidence](../../../testing/production-readiness/README.md)
for executed controls and the remaining acceptance gates. Local fixture results
do not qualify a production target.
