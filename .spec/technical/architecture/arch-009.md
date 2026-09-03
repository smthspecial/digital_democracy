---
id: ARCH-009
type: arch
title: "Integration & E2E test strategy"
status: draft
linkedIds: ADR-019,ADR-021,EPIC-001,EPIC-002,EPIC-003,EPIC-004,EPIC-005,EPIC-006,EPIC-007,EPIC-008,EPIC-009,EPIC-010,EPIC-011,EPIC-012,EPIC-013
created: 2026-08-27
---

## Overview

Every one of the 17 services (13 TypeScript, 4 Go — ADR-019) already carries an in-process unit test suite, and CI (`.github/workflows/ci.yml`) runs those suites per service: `pnpm turbo run lint typecheck test build` for the TS workspace, `go vet && go test && go build` per Go service, then a Docker build per service. But every one of those suites tests exactly one service with every cross-service dependency replaced by a local no-op stub — the seam pattern used throughout the codebase (`AuditEmitter`, `ConstitutionalReviewer`, `VoteSessionRequester`, `AssignmentChecker`, `DelegationResolver`, and their equivalents in every other service). No test in the repository today boots two real services and lets one actually call the other, and no test drives a citizen-facing journey across the full chain of services it touches. This document defines what closes that gap: the test levels, the environment/tooling approach, and a shared vocabulary and traceability convention that every flow-specific test plan (ARCH-010 through ARCH-022, §7) follows.

This document and the 13 that follow it are **test plans**, not test code. They enumerate the scenarios — happy paths and edge cases — that integration and e2e tests must cover once written; writing those tests is tracked as separate implementation work against the backlog items each flow doc links to.

---

## 1. Definitions

| Level | Scope | Status |
|---|---|---|
| **Unit** | One service, in-process, every cross-service dependency replaced by its no-op/injectable stub. | Exists today, per service. Out of scope for this test plan. |
| **Integration** | Two or more real services, wired together over real HTTP (or real in-process `httptest`/`inject` transport), no mocked business logic on either side. No gateway, no UI. | Does not exist yet. Scope of ARCH-010..022. |
| **End-to-end (e2e)** | The full chain of services a citizen-facing governance journey touches, driven through the same HTTP surface a real client would use. `apps/web` has no implementation beyond a bare Next.js scaffold, so "e2e" here means "through every service boundary the journey crosses," not "through a browser" — that changes once a web client exists to drive instead. | Does not exist yet. Scope of ARCH-010..022. |

A single flow doc typically specifies both integration scenarios (one service boundary at a time) and e2e scenarios (the full journey) where the distinction is meaningful; some flows are narrow enough that every scenario is e2e by the definition above.

---

## 2. Environment & tooling approach

- **No docker-compose, no Kubernetes, no external infra dependency to run these tests.** Every Go service is stdlib-only (`net/http`) and every TS service runs its own in-memory store; integration and e2e tests keep that property. A TS integration test boots the real services under test as in-process `Fastify` instances (via `buildServer()`) on ephemeral ports and has one call another over real `fetch`, not `app.inject` across service boundaries (in-process `inject` stays for single-service unit tests only). A Go integration test boots the real services as `httptest.Server` instances and wires them with a real `http.Client`.
- **The no-op seam becomes a real HTTP-calling implementation of the same interface.** Every cross-service seam already defined (`VoteSessionRequester`, `AssignmentChecker`, `DelegationResolver`, `AuditEmitter`, etc.) gets a second implementation — e.g. `HttpVoteSessionRequester` — that performs the real call against a live instance of the target service, satisfying the same interface the no-op default does. This is new production code, not test-only code; each flow doc below calls out which HTTP seam implementations it depends on where one doesn't exist yet, so that prerequisite is visible before the test itself is written.
- **Async/queue-backed seams get a third tooling pattern, alongside the HTTP one above.** ADR-023 (superseding ADR-016's eventual Kafka backbone) stood up a real, lightweight event backbone — NATS with JetStream — as a single ~15-20MB `nats-server` binary, matching this document's "boot the real thing as a process, not a mock" convention exactly: an async integration/e2e test spawns a real `nats-server` (`spawnNatsServer()` in `services/ts/proposal-service/src/e2e/harness.ts`), a real publishing service, and a real consuming service, and asserts on what the consumer durably persisted — no mocked broker, no in-memory stub standing in for the queue. `packages/go/eventbus` and `packages/event-bus` are the two client libraries every service's queue-backed seam implementation (e.g. `natsAuditEmitter`) uses; `services/ts/proposal-service/src/e2e/async-audit-queue.e2e.test.ts` is the reference example, covering `audit.append` (DP-036) end to end including a durability scenario (kill the consumer mid-flight, confirm the message survives and is redelivered once it's back). As of this ADR, `AuditEmitter` is the one seam actually migrated across services (see ADR-023's own scope note); a flow doc whose seam is still no-op/HTTP-only continues to follow the HTTP-tooling bullet above or, if genuinely nothing callable exists yet for that seam (HTTP or queue), still marks the scenario `blocked on: <what's missing>` rather than silently assuming it works.
- Fixtures are built through each service's own public API (e.g. an integration test gets a proposal into `voting` status by POSTing through proposal-service's real lifecycle endpoints, the same way `advanceTo()` does in proposal-service's own unit tests), not by reaching into another service's store directly — that would test something no real client can do.

---

## 3. Shared edge-case taxonomy

Every flow doc groups its edge cases under this fixed set of categories, so coverage gaps are easy to spot by scanning headers across documents:

1. **Input validation** — malformed, missing, or out-of-range request fields.
2. **State-machine violations** — an action attempted from the wrong status, a double action, an action taken out of order.
3. **Authorization / eligibility** — wrong actor, unassigned reviewer, citizen outside the eligible jurisdiction/domain, missing or insufficient assurance tier.
4. **Threshold & boundary conditions** — exactly-at-threshold, one-under, one-over, zero/empty population, empty collections.
5. **Concurrency & idempotency** — double-submit, concurrent writers to the same record, replay of an already-processed request.
6. **Cross-service failure & degradation** — downstream service down, slow, or erroring; how the caller is expected to behave (fail closed vs. degrade).
7. **Data integrity & audit** — whether the action correctly produces the audit trail / hash-chain entry / status transition record it is specified to produce.

Not every category applies to every flow; a flow doc omits a category rather than padding it with a forced scenario.

---

## 4. Traceability & naming convention

- Within a flow doc, happy-path scenarios are numbered `HP-1`, `HP-2`, ...; edge cases are numbered `EC-1`, `EC-2`, ... within their taxonomy category.
- Every scenario cites the FR/DP/NFR/ADR/AUTH id(s) it verifies, and the service(s) exercised.
- Once implemented, automated tests are named `IT-<ARCH-NNN>-<scenario>` (integration) or `E2E-<ARCH-NNN>-<scenario>` (e2e) — e.g. `IT-012-HP1`, `E2E-016-EC4` — so a failing CI test name traces back to the exact scenario in the exact flow doc without indirection.
- Each flow doc closes with a traceability table: scenario id → FR/DP/NFR ids → level (integration/e2e) → automated test id (`TBD` until implemented).

---

## 5. What "happy path" and "edge case" mean here

A **happy path** is the fully-eligible, fully-valid, uncontested version of the flow, end to end, asserting the final state is exactly what the spec promises (not just "no error"). An **edge case** is any deviation from that — invalid input, wrong actor, wrong timing, boundary value, concurrent conflict, downstream failure, or a legitimate-but-unusual path the spec explicitly carves out (e.g. a competing proposal, a delegation revoked mid-chain, a deadlock escape hatch). "As many edge cases as possible" means exhausting the categories in §3 against the flow's actual state machine and validation rules as implemented in the current code — not restating the spec's prose, which is already captured in the linked FR/DP documents themselves.

---

## 6. Out of scope

- Frontend/UI e2e through a browser — `apps/web` has no implementation to drive yet.
- Load/performance testing methodology — owned by ARCH-007 (scalability and capacity plan).
- Security penetration testing — a separate discipline from functional correctness.
- Execution tooling for the disaster-recovery/failover drills ARCH-022 enumerates as scenarios (which tool triggers a regional outage, how results get published) — ARCH-022 defines what must be verified, not how the drill infrastructure is built.

---

## 7. Index of flow test plans

| Doc | Flow | Epic | Primary services |
|---|---|---|---|
| [ARCH-010](arch-010.md) | Citizen identity registration & verification | EPIC-001 | identity-service, auth-service, governance-role-service |
| [ARCH-011](arch-011.md) | Sphere of impact: jurisdiction, residency & scope assignment | EPIC-002 | jurisdiction-service, proposal-service |
| [ARCH-012](arch-012.md) | Problem → proposal lifecycle | EPIC-003 | problem-service, proposal-service |
| [ARCH-013](arch-013.md) | Competency acquisition, challenge & conflict of interest | EPIC-004 | competency-service, reputation-service |
| [ARCH-014](arch-014.md) | Public deliberation, preference formation & deadlock resolution | EPIC-005 | deliberation-service, ai-synthesis-service, proposal-service, governance-role-service |
| [ARCH-015](arch-015.md) | Budget democracy: categories, allocation votes & the public ledger | EPIC-006 | budget-service, proposal-service |
| [ARCH-016](arch-016.md) | Voting lifecycle: session, tokens, ballot, tally, certification | EPIC-007 | voting-service, proposal-service, delegation-service, audit-service |
| [ARCH-017](arch-017.md) | Implementation & public oversight: projects, milestones & outcomes | EPIC-008 | project-service, budget-service, reputation-service |
| [ARCH-018](arch-018.md) | Civic knowledge & participation: assignments, quotas & inactivity | EPIC-009 | civic-duty-service, governance-role-service, notification-service |
| [ARCH-019](arch-019.md) | Delegated expertise (liquid democracy) | EPIC-010 | delegation-service, voting-service |
| [ARCH-020](arch-020.md) | Constitutional layer: protected rights & constitutional review | EPIC-011 | audit-service, proposal-service, governance-role-service |
| [ARCH-021](arch-021.md) | System integrity & anti-capture: audit log, multi-approval & rotation | EPIC-012 | audit-service, governance-role-service, identity-service |
| [ARCH-022](arch-022.md) | Platform reliability, scale & security operations | EPIC-013 | auth-service, all services (topology-level) |

EPIC-013 (ARCH-022) differs in kind from the other twelve: its scenarios describe operational resilience and access-control behavior (regional failover, break-glass access, session anomaly response) rather than a single citizen-facing business journey, per §6's boundary with ARCH-007/ARCH-008.
