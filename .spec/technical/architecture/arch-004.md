---
id: ARCH-004
type: arch
title: "Data process classification: sync, async, and cron"
status: active
linkedIds: ADR-005,NFR-008
created: 2026-06-18
---

## Overview

Every data operation in the system is classified into one of three execution modes. Synchronous (sync) processes execute in-request and return an immediate response. Asynchronous (async) processes are enqueued and executed in the background, decoupled from the originating request. Cron processes run on a fixed schedule, independent of user activity. The classification is driven by latency requirements, blast radius, cascading side-effects, and data consistency constraints.

Individual process definitions live in `.spec/technical/data-processes/` as `dp-NNN.md` files with `type: data-proc` and `processType: sync | async | cron`.

---

## Sync processes (DP-001 – DP-023)

User-initiated write or read operations that must complete within the HTTP request-response cycle. Each is a bounded, single-step operation with no cascading logic. Side-effects (audit log, notifications) are enqueued as async events and do not block the response.

| ID | Title | Actor | Service |
|----|-------|-------|---------|
| DP-001 | Register civic identity | unauthenticated | SRV-001 |
| DP-002 | Submit identity verification evidence | citizen (pending) | SRV-001 |
| DP-003 | Submit problem | citizen (active) | SRV-003 |
| DP-004 | Endorse problem | citizen (active, in jurisdiction) | SRV-003 |
| DP-005 | Create proposal | citizen (active) | SRV-004 |
| DP-006 | Add proposal constraint | proposal author | SRV-004 |
| DP-007 | Add proposal budget | proposal author | SRV-004 |
| DP-008 | Post deliberation argument | citizen (active) | SRV-006 |
| DP-009 | Declare preference | citizen (active) | SRV-006 |
| DP-010 | Declare conflict of interest | citizen with active competency | SRV-005 |
| DP-011 | Apply for domain competency | citizen (active) | SRV-005 |
| DP-012 | Submit competency challenge | citizen (active) | SRV-005 |
| DP-013 | Submit budget allocation vote | citizen (active) | SRV-007 |
| DP-014 | Create delegation | citizen (active) | SRV-010 |
| DP-015 | Revoke delegation | delegating citizen | SRV-010 |
| DP-016 | Cast ballot | citizen (active, token issued) | SRV-008 |
| DP-017 | Verify ballot inclusion | citizen with verification_code | SRV-008 |
| DP-018 | Report project milestone | operator or oversight role | SRV-013 |
| DP-019 | Record ledger entry | operator | SRV-007 |
| DP-020 | File scope challenge | citizen (active) | SRV-004 |
| DP-021 | Publish expert assessment | expert (active competency, no COI) | SRV-005 |
| DP-022 | Submit outcome evaluation | auditor or oversight role | SRV-013 |
| DP-023 | Submit approval decision | governance_role (active term, no COI) | SRV-011 |

---

## Async / queue processes (DP-024 – DP-043)

Background operations enqueued when events occur and consumed by workers. The originating sync request returns immediately; the side-effect executes later with guaranteed delivery. Each has a named queue topic. Workers are idempotent.

| ID | Title | Queue | Service |
|----|-------|-------|---------|
| DP-024 | Duplicate identity detection | identity.check | SRV-001 |
| DP-025 | Eligibility token batch issuance | voting.eligibility | SRV-008 |
| DP-026 | Vote tally computation | voting.tally | SRV-008 |
| DP-027 | Vote session certification | voting.certify | SRV-008 |
| DP-028 | Proposal threshold check | proposals.threshold | SRV-003 |
| DP-029 | Proposal status transition | proposals.lifecycle | SRV-004 |
| DP-030 | Impact scope assignment routing | proposals.scope | SRV-004 |
| DP-031 | Competency verification pipeline | competency.review | SRV-005 |
| DP-032 | Competency challenge review routing | competency.challenge | SRV-005 |
| DP-033 | Conflict-of-interest auto-exclusion | integrity.coi | SRV-005 |
| DP-034 | Constitutional review trigger | constitutional.review | SRV-012 |
| DP-035 | Multi-approval workflow coordination | governance.approvals | SRV-011 |
| DP-036 | Audit log append | audit.append | SRV-012 |
| DP-037 | AI policy synthesis | ai.synthesis | SRV-016 |
| DP-038 | Reputation score update | reputation.update | SRV-014 |
| DP-039 | Notification dispatch | notifications.dispatch | SRV-015 |
| DP-040 | Civic assignment generation | civic.assign | SRV-009 |
| DP-041 | Delegation chain resolution | voting.delegation | SRV-010 |
| DP-042 | Identity revocation cascade | identity.revoke | SRV-001 |
| DP-043 | Protocol change delayed execution | governance.protocol | SRV-011 |

### Queue reliability requirements

- **audit.append** — at-least-once with deduplication; hash-chain ordering enforced by audit-service; failure surfaces as an alert but does not block user actions.
- **voting.tally / voting.certify** — exactly-once semantics; tally worker holds a distributed lock per session; retries are idempotent via session-level idempotency key.
- **voting.eligibility** — at-least-once; token issuance is idempotent via unique constraint on `(vote_session_id, citizen_id)`.
- **identity.revoke / identity.check** — at-least-once; workers are idempotent on citizen status.
- All other queues — at-least-once with idempotent workers.

---

## Cron processes (DP-044 – DP-058)

Time-driven jobs that run on a fixed schedule. They enforce time-based state transitions (expiry, rotation, close), aggregate periodic data (participation scores, budget allocations), and perform maintenance sweeps.

| ID | Title | Schedule (UTC) | Service |
|----|-------|----------------|---------|
| DP-044 | Competency expiry enforcement | daily 02:00 | SRV-005 |
| DP-045 | Delegation expiry enforcement | daily 03:00 | SRV-010 |
| DP-046 | Vote session open trigger | every 15 min | SRV-008 |
| DP-047 | Vote session close trigger | every 15 min | SRV-008 |
| DP-048 | Monthly participation quota scoring | 1st of month 04:00 | SRV-009 |
| DP-049 | Inactivity escalation sweep | weekly Mon 05:00 | SRV-009 |
| DP-050 | Governance role rotation check | daily 06:00 | SRV-011 |
| DP-051 | Budget allocation aggregation | end of allocation period | SRV-007 |
| DP-052 | Civic assignment load balancing | daily 07:00 | SRV-009 |
| DP-053 | Outcome evaluation trigger | daily 08:00 | SRV-013 |
| DP-054 | Audit pool refresh | monthly 1st 09:00 | SRV-009 |
| DP-055 | Ledger reconciliation | daily 01:00 | SRV-007 |
| DP-056 | Duplicate identity sweep | weekly Sun 00:00 | SRV-001 |
| DP-057 | Cooling-off period check | every 30 min | SRV-008 |
| DP-058 | Stale scope challenge escalation | daily 10:00 | SRV-004 |

---

## Process dependency map

```
DP-004 (endorse problem)
  └─ enqueues DP-028 (threshold check)
       └─ threshold met → enqueues DP-029 (lifecycle: gathering_support → development)
            └─ gates pass → enqueues DP-034 (constitutional review) + DP-030 (scope routing)
                 └─ cleared → DP-029 (lifecycle: development → voting)
                      └─ enqueues DP-025 (eligibility batch, via DP-046)

Vote lifecycle
  DP-046 (open trigger) → DP-025 (eligibility batch)
  DP-047 (close trigger) → DP-026 (tally) → DP-027 (certify)
                                            → DP-036 (audit) + DP-039 (notify) + DP-038 (reputation)

Critical / protocol change
  DP-023 (submit approval) → DP-035 (multi-approval coordination)
    └─ all approvals + delay → DP-043 (delayed execution) → DP-036 (audit)

Every governance write → DP-036 (audit.append) + DP-039 (notifications.dispatch)
```
