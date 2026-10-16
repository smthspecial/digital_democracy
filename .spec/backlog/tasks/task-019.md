---
id: TASK-019
type: task
title: "Qualify replica-safe rate limits bounded jobs and recovery"
status: in-progress
storyId: US-052
priority: high
dependsOn: TASK-010,TASK-011,TASK-013,TASK-014,TASK-015,TASK-018
linkedIds: REL-002,NFR-009,US-053,US-056,US-058,BUG-011,BUG-021,BUG-022
created: 2026-10-08
---

## Outcome

Security limits protect the service without blocking legitimate voting at the declared release load.

## Responsible role

Performance/platform engineer. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Add trusted distributed per-citizen/operation rate limits at the edge; validate tokens and sanitize forwarded headers. Keep process/socket-peer controls as bounded backstops and verify gateway fan-in does not throttle all citizens together.
- [ ] Provide safe paginated/archive reads and bounded queued/offline duplicate, audit-chain and constitutional-review work where synchronous caps are exceeded. Fail closed until each required worker is available.
- [ ] Exercise multiple replicas, restarts, DB/broker/verifier outages, durable ballot acknowledgement, replay retention and spent-token races with synthetic data.
- [ ] Measure against the declared scope and existing NFR-009 targets. National readiness requires 100,000 concurrent ballot sessions at p99 <=1s, the specified read/write budgets, and the existing regional-failover requirements.
- [ ] Publish sanitized load/recovery results and essential voting/security/certificate/backup alerts with incident owners. Do not claim national resilience from a single-node staging benchmark.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.

## Implementation checkpoint — 2026-10-08

See [implementation evidence](../../../testing/production-readiness/README.md)
for executed controls and the remaining acceptance gates. Local fixture results
do not qualify a production target.

## Local concurrency checkpoint — 2026-10-14

BUG-021/BUG-022 fix committed-tally replacement and per-election cast
serialization. Independent Postgres pools/services exercise sixteen issuance
and spending races, eight tally writers, reconstructed services, durable
receipts, close locking, failed-spend rollback and unavailable-pool recovery.
Regenerated SQL repositories also bring existing query bounds/predicates into
the compiled stores; a 1,001-session fixture verifies the 1,000-row listing cap.
See [audit checkpoint](../../../testing/production-readiness/audit-next-items-results.json).

No new protocol or schema was introduced. Production crypto remains blocked.
Distributed edge limits, queued work, real process/database restarts, full
deployment outage drills, capacity targets and alerts remain open. These local
controls do not complete this ticket's release acceptance criteria.
