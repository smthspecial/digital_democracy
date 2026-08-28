---
id: ARCH-021
type: arch
title: "System integrity & anti-capture: audit log, multi-approval & rotation"
status: draft
linkedIds: EPIC-012,FR-001,FR-006,FR-007,FR-060,FR-061,FR-062,FR-063,FR-065,FR-066,FR-067,DP-023,DP-024,DP-035,DP-036,DP-043,DP-050,DP-056,DP-062,DP-063,DP-064,ADR-001,ADR-005,ADR-009,ADR-011,ADR-019
created: 2026-08-27
---

## Overview

This flow covers the three services EPIC-012 assigns as System Integrity & Anti-Capture's backbone: `audit-service`'s append-only hash-chained log (FR-060, FR-066), `governance-role-service`'s multi-approval coordination and role rotation (FR-061, FR-062, FR-065, FR-067), and `identity-service`'s one-person-one-identity duplicate detection (FR-001, DP-024, DP-056). All three are fully real, independently running services (`audit-service` in Go on port 5003, the other two in TypeScript/Fastify on ports 4009 and 4001) with their own in-memory stores and existing unit suites — this doc does not restate what those suites already cover, only what is visible when the services are driven together, or driven at their real HTTP surface, the way a real caller would.

Ground-truthing the code surfaced this flow's central gap: every cross-service seam that should carry these guarantees end to end is wired to a no-op or always-permissive in-process default in production code today. `identity-service`'s and `governance-role-service`'s `AuditEmitter`s never reach `audit-service`'s real `POST /audit/log`; `governance-role-service`'s `ProtocolGateChecker` never reaches `audit-service`'s real `POST /audit/protocol-changes/gate`; `governance-role-service`'s `COIChecker` never reaches `competency-service`; `identity-service`'s `ApprovalGate` (gating suspend/revoke) never reaches `governance-role-service`'s real approval status; and `governance-role-service`'s `ReplacementRequester`/`NotificationEmitter` never reach `civic-duty-service`/`notification-service`. Per ARCH-009 §2, closing each of these requires new production code (`HttpAuditEmitter`, `HttpProtocolGateChecker`, `HttpCOIChecker`, `HttpApprovalGate`, etc.); scenarios that depend on one are marked `blocked on:` below rather than assumed to work.

A second grounding note: DP-062 (role acceptance handshake), DP-063 (operator appointment), and DP-064 (protocol council election) each describe multi-step business orchestrations — `pending_acceptance`/accept/decline, appointment-proposal → multi-approval → delay → credential issuance, candidacy → election → certification. None of these exist as distinct endpoints in `governance-role-service` today: `POST /governance-roles/roles` is a single generic create-and-immediately-active call with no `status` field and no accept/decline routes. Scenarios below build on the generic role/approval/execution primitives the service actually exposes, and call out where a DP's specific orchestration has no corresponding code (§4.2 EC-20).

---

## 1. Services & seams in scope

| Service | Role in this flow | Real HTTP call today or seam-stub today |
|---|---|---|
| `audit-service` (SRV-012, Go, port 5003, `/audit`) | Owns the hash-chained `audit_log` (DP-036, FR-060); constitutional rights/review (DP-034); protocol-change delayed-execution gate (DP-043, FR-065/FR-067); readable by multiple independent audit bodies (FR-066) | Fully real HTTP endpoints: `POST/GET /audit/log`, `GET /audit/log/verify`, `POST/GET /audit/rights`, `POST /audit/proposals/{id}/constitutional-review`, `POST /audit/protocol-changes/gate`. No other service in this codebase calls any of them — every `AuditEmitter` elsewhere defaults to a no-op. |
| `governance-role-service` (SRV-011, TS, port 4009, `/governance-roles`) | Owns `governance_role` terms/layers (FR-062); multi-approval coordination (FR-061, DP-023/DP-035); rotation sweep (FR-062, DP-050); protocol-change execution gate (FR-065/FR-067) | Fully real HTTP endpoints: `POST/GET /governance-roles/roles`, `POST /governance-roles/approvals`, `GET /governance-roles/actions/:actionRef/status`, `POST /governance-roles/actions/:actionRef/execute`, `POST /governance-roles/rotation/sweep`. All 6 of its own collaborator seams (`protocolGateChecker`, `coiChecker`, `protocolChangeExecutor`, `notificationEmitter`, `replacementRequester`, `auditEmitter`) default to no-op/always-true/always-false stubs (`collaborators.ts`) — none calls `audit-service`, `competency-service`, `civic-duty-service`, or `notification-service`. |
| `identity-service` (SRV-001, TS, port 4001, `/identity`) | One-person-one-identity invariant (FR-001); duplicate detection (DP-024) and sweep (DP-056) as anti-capture enforcement; revocation requiring multi-approval (FR-006/FR-007) | Fully real HTTP endpoints: `POST /identity/citizens`, `GET /identity/citizens[/:id]`, `POST /identity/citizens/:id/verifications`, `POST /identity/citizens/:id/suspend`, `POST /identity/citizens/:id/revoke`, `POST /identity/duplicates/scan`. `ApprovalGate` (suspend/revoke) defaults to always-true (`createDefaultApprovalGate`); `AuditEmitter` defaults to no-op; `DuplicateSignal` (the sweep's fuzzy matcher) is a real in-process case-insensitive `public_handle` comparator, not an HTTP call to another service. |
| `competency-service` | Would supply `governance-role-service`'s COI signal (FR-063) | Referenced only as a seam target; no HTTP caller exists anywhere in this codebase. |
| `civic-duty-service` | Would consume `governance-role-service`'s rotation replacement requests (DP-050 → DP-040) | Referenced only as a seam target; no HTTP caller exists. |
| `notification-service` | Would receive off-boarding/decision notifications (DP-039) | Referenced only as a seam target; no HTTP caller exists. |

---

## 2. Preconditions & fixtures

Every scenario builds its starting state through each service's own real API, per ARCH-009 §2 — never by writing into any service's in-memory store directly:

1. **Governance role** — `POST /governance-roles/roles` (`citizen_id`, `role_type` ∈ `{auditor,reviewer,oversight,operator,platform_operator,review_body}`, `layer` ∈ `{protocol,implementation,audit,citizen}`, `randomized`, `term_start`/`term_end` ISO-8601, `term_end` after `term_start`) → `201`. Use a distinct `citizen_id` per role to obtain "independent" approvers for §4.3 scenarios.
2. **Fully-approved action** — create three active roles for three distinct citizens, then `POST /governance-roles/approvals` once per role against the same `action_ref`, one of `citizen_supermajority`/`audit_confirmation`/`body_endorsement` each → `GET /governance-roles/actions/:actionRef/status` returns `fully_approved: true`.
3. **Executed action** — from step 2, `POST /governance-roles/actions/:actionRef/execute` with `delay_elapsed: true`, `publicly_visible: true` → `executed: true` (the happy path needs no external dependency since `protocolGateChecker` defaults to always-confirmed).
4. **Rotation sweep clock control** — `POST /governance-roles/rotation/sweep` accepts an optional `now` field (ISO-8601); pass a fixed instant so "within 7 days of `term_end`" scenarios don't depend on wall-clock time.
5. **Audit log entries** — `POST /audit/log` directly (`action_type`, `actor_ref`, `payload`, `idempotency_key`), since no producer service calls it automatically today (§1). This is the only way to get entries into the chain for read/verify scenarios.
6. **Constitutional rights substrate** — `POST /audit/rights` (`name`, `description`, `protected: true`) before `POST /audit/proposals/{id}/constitutional-review`.
7. **Citizen identity** — `POST /identity/citizens` (`public_handle`, `raw_legal_identifier`) → `pending`; `POST /identity/citizens/:id/verifications` (`evidence_ref`, `outcome: "verified"`) → `active`.
8. **Cross-service wiring** — because no live HTTP call connects any two of these three services today (§1), a fixture needing "an audited approval" or "a suspended citizen with a real audit trail" is built by the test client issuing both calls itself (e.g. `POST` the approval to `governance-role-service`, then separately `POST` the equivalent record to `audit-service`'s `/audit/log`) — client-orchestrated, not service-to-service; scenarios are labeled accordingly.

---

## 3. Happy path scenarios

**HP-1 — Audit log append chains sequentially and verifies.**
1. `POST /audit/rights` — not required here, skip. `POST /audit/log` five times with distinct `action_type`/`payload` values, no `idempotency_key`.
2. `GET /audit/log` → `200`, 5 entries in append order, each entry's `prev_hash` equal to the previous entry's row hash (recomputable from its own fields per `chain.go`).
3. `GET /audit/log/verify` → `200`, `{ valid: true, broken_at: null }`.
Cites: FR-060, DP-036. Level: integration.

**HP-2 — Multi-approval full lifecycle: three independent approvals unlock execution.**
1. Create three active governance roles for three distinct citizens (§2.1).
2. `POST /governance-roles/approvals` once per role against `action_ref: "protocol-change-1"`, one of the three required `approval_type`s each, `decision: "approved"`.
3. `GET /governance-roles/actions/protocol-change-1/status` → `200`, `fully_approved: true`, `satisfied_approval_types` containing all three.
4. `POST /governance-roles/actions/protocol-change-1/execute` with `delay_elapsed: true`, `publicly_visible: true` → `200`, `executed: true`, `already_executed: false`.
Cites: FR-061, FR-065, FR-067, DP-023, DP-035. Level: e2e (full approval-to-execution journey).

**HP-3 — Re-executing an already-executed action is idempotent.**
1. Continue from HP-2.
2. `POST /governance-roles/actions/protocol-change-1/execute` again with the same body.
3. Expect `200`, `already_executed: true`, `executed_at` identical to HP-2's value.
Cites: FR-061. Level: integration.

**HP-4 — Rotation sweep flags a role inside its 7-day off-boarding window exactly once.**
1. Create a role with `term_end` 3 days after a fixed `now`.
2. `POST /governance-roles/rotation/sweep` with `{ now }` → `200`, the role appears in `flagged`, `offboarding_notified: true`.
3. Repeat the same sweep call with the same `now` → `200`, `flagged: []`, `flagged_count: 0` (no re-flag, no re-notify).
Cites: FR-062, DP-050. Level: integration.

**HP-5 — Exact-legal-identity duplicate registration is blocked at the point of registration.**
1. `POST /identity/citizens` with `raw_legal_identifier: "X"` → `201`.
2. `POST /identity/citizens` again with the same `raw_legal_identifier: "X"` (different `public_handle`) → `409` "An identity already exists for this legal identifier".
3. `GET /identity/citizens` → exactly one citizen record exists.
Cites: FR-001. Level: integration.

**HP-6 — Duplicate-identity sweep catches a fuzzy signal match the hash check wouldn't.**
1. `POST /identity/citizens` twice with two different `raw_legal_identifier` values but `public_handle`s that differ only by case/whitespace (e.g. `"Jane Doe"` / `"jane doe"`) → both `201` (distinct legal hashes, so HP-5's block does not trigger).
2. `POST /identity/duplicates/scan` → `200`, `signal_matches` contains the pair; `hash_matches` is empty.
Cites: FR-001, DP-024, DP-056. Level: integration.

**HP-7 — Redundant independent audit bodies read the same log concurrently and consistently.**
1. Append 10 entries via `POST /audit/log`.
2. Issue two concurrent `GET /audit/log` calls (simulating two independent audit bodies, FR-066) and one concurrent `POST /audit/log` append.
3. Both readers return internally consistent snapshots (each a valid prefix/full view, no torn entries); a following `GET /audit/log/verify` returns `valid: true`.
Cites: FR-066. Level: integration.

---

## 4. Edge cases

### 4.1 Input validation

- **EC-1.** `POST /audit/log` with an `action_type` outside the six valid values → `400` (Go `ActionType.Valid()` checked in `Store.Append`). Cites: FR-060. Level: integration.
- **EC-2.** `POST /audit/log` with an empty/missing `actor_ref` → `400` "actor_ref is required". Cites: FR-060. Level: integration.
- **EC-3.** `POST /audit/log` with a malformed JSON body → `400` "malformed JSON body" (`decodeJSON`). Cites: FR-060. Level: integration.
- **EC-4.** `GET /audit/log?action_type=bogus` → `400` "invalid action_type filter". Cites: FR-060. Level: integration.
- **EC-5.** `POST /audit/rights` with an empty/missing `name` → `400` "name is required". Cites: FR-060 (substrate for FR-067's constitutional gate). Level: integration.
- **EC-6.** `POST /governance-roles/roles` with `role_type` outside the six enum values, or with an extra unrecognized property (`additionalProperties: false`) → `400`. Cites: FR-062. Level: integration.
- **EC-7.** `POST /governance-roles/roles` missing any required field (`citizen_id`, `role_type`, `layer`, `randomized`, `term_start`, `term_end`) → `400`. Cites: FR-062. Level: integration.
- **EC-8.** `POST /governance-roles/approvals` with `approval_type` outside `{citizen_supermajority, audit_confirmation, body_endorsement}`, or `decision` outside `{approved, rejected}` → `400`. Cites: FR-061. Level: integration.
- **EC-9.** `POST /governance-roles/actions/:actionRef/execute` missing `delay_elapsed` or `publicly_visible` → `400` (both required by schema). Cites: FR-065. Level: integration.
- **EC-10.** `POST /identity/citizens` with empty/missing `public_handle` or `raw_legal_identifier` (`minLength: 1`) → `400`. Cites: FR-001. Level: integration.
- **EC-11.** `POST /identity/citizens/:id/verifications` with `outcome` outside `{verified, rejected}` or `method` outside `{national_id, passport, gov_credential}` → `400`. Cites: FR-001. Level: integration.

### 4.2 State-machine violations

- **EC-12.** `POST /governance-roles/approvals` with an `approver_role_id` whose `term_start` is still in the future relative to `now` → `403` "approver role is not active for the current term" (`isRoleActive`). Cites: FR-061. Level: integration.
- **EC-13.** Same call with a role whose `term_end` has already passed → `403`, same message. Cites: FR-061. Level: integration.
- **EC-14.** `POST /governance-roles/actions/:actionRef/execute` before all three approval types are satisfied → `409` "action does not have all three required approval types". Cites: FR-061, FR-065. Level: integration.
- **EC-15.** Fully approved but `delay_elapsed: false` → `409` "delay period has not elapsed" — checked before `publicly_visible` and before the gate (confirmed check order in `execution.ts`). Cites: FR-065. Level: integration.
- **EC-16.** Fully approved, `delay_elapsed: true`, `publicly_visible: false` → `409` "change was not publicly visible during the delay window". Cites: FR-065, FR-067. Level: integration.
- **EC-17.** Execution rejected because `protocolGateChecker.isConfirmed()` returns false → `403` "protocol change gate has not confirmed this action" — reachable only via a unit-injected fake (`execution.test.ts`); the real running server's production wiring defaults `protocolGateChecker` to always-confirmed, so this is not reachable through the live HTTP surface today. `blocked on: HttpProtocolGateChecker seam does not exist.` Cites: FR-065, FR-067, DP-043. Level: integration (once unblocked).
- **EC-18.** `POST /identity/citizens/:id/suspend` or `.../revoke` on an unknown `citizen_id` → `404` "Citizen not found" — `getCitizen` is checked before the approval gate (order confirmed in `identity.ts`). Cites: FR-006. Level: integration.
- **EC-19.** A citizen revoked via `.../revoke` has their `legal_identity_hash` permanently retained in `findCitizenByLegalHash`'s index — nothing exempts `revoked` (or `suspended`) records from the uniqueness check, so a legitimate re-registration attempt using the same legal identifier is blocked forever with the same `409` as HP-5, with no code path that releases the hash. Cites: FR-001, FR-006. Level: integration.
- **EC-20.** DP-062 (role acceptance handshake), DP-063 (operator appointment), and DP-064 (protocol council election) each describe a `pending_acceptance`/candidacy/election orchestration with dedicated state; `governance-role-service` exposes none of it — `POST /governance-roles/roles` creates a role that is immediately usable (no `status` field, no accept/decline endpoints, no candidacy endpoints). Any scenario claiming to exercise DP-062/063/064 end-to-end must instead compose the generic role/approval/execute primitives directly. `blocked on: DP-062/DP-063/DP-064 have no dedicated endpoints in governance-role-service.` Level: integration (documents current scope, not a passing scenario).

### 4.3 Authorization / eligibility

- **EC-21.** `POST /governance-roles/approvals` with an `approver_role_id` that doesn't reference any existing role → `404` "approver_role_id does not reference an existing governance role". Cites: FR-061. Level: integration.
- **EC-22.** Approval submission rejected because `coiChecker.hasConflict()` returns true → `403` "citizen has a conflict of interest for this action" — reachable only via a unit-injected fake (`approvals.test.ts`); production wiring defaults `coiChecker` to always-no-conflict. `blocked on: HttpCOIChecker seam / competency-service caller does not exist.` Cites: FR-063. Level: integration (once unblocked).
- **EC-23.** A second approval submitted by the **same citizen** for the same `action_ref`, even under a **different** `approval_type`, is rejected: `409` "citizen has already submitted an approval for this action_ref" — this is the concrete enforcement of FR-061's "no single entity can complete a structural change alone." Cites: FR-061. Level: integration.
- **EC-24.** The same citizen approving **two different** `action_ref`s → both succeed (per-action independence is real, confirmed by `approvals.test.ts`). Cites: FR-061. Level: integration.
- **EC-25.** Two **different** citizens both submit the **same** `approval_type` for the same `action_ref` → both `201`; `GET .../status` still reports that type satisfied only once and the two remaining required types remain unsatisfied — duplicate-type approvals cannot substitute for the missing types. Cites: FR-061. Level: integration.
- **EC-26.** `submitApproval` never checks the approver role's `role_type` against the `approval_type` being submitted — a role created with `role_type: "operator"` can submit an `audit_confirmation` or `citizen_supermajority` approval exactly as freely as an `"auditor"`/`"reviewer"` role could. Nothing in the running code ties the three required approval types to the role types the White Paper module implies they should come from. **Gap** directly relevant to EPIC-012's "no single layer can independently modify, execute, and validate governance actions" acceptance criterion. Cites: FR-061, FR-067. Level: integration.
- **EC-27.** `POST /identity/citizens/:id/suspend` and `.../revoke` succeed for **any** caller today, because `approvalGate.hasRequiredApprovals()` defaults to always-true in production. FR-006/FR-007's "no single operator can revoke unilaterally" is unenforced end-to-end in the running system. `blocked on: HTTP ApprovalGate wiring from identity-service to governance-role-service does not exist.` Cites: FR-006, FR-007. Level: integration (once unblocked).
- **EC-28.** None of `audit-service`'s `POST /audit/proposals/{id}/constitutional-review`, `POST /audit/protocol-changes/gate`, or `governance-role-service`'s `POST /governance-roles/rotation/sweep` perform any caller-identity or authorization check — any client can invoke them for any id. Gap relative to FR-067's "operators cannot modify governance rules, vote outcomes, or identity logic": nothing in the HTTP layer prevents an operator-layer caller from invoking the protocol-change gate or rotation sweep directly. Cites: FR-067. Level: integration.

### 4.4 Threshold & boundary conditions

- **EC-29.** Approver role exactly at `term_start` (`now == term_start`) → active, approval accepted (`isRoleActive` uses inclusive `<=`). Cites: FR-061. Level: integration.
- **EC-30.** Approver role exactly at `term_end` (`now == term_end`) → still active, accepted (inclusive `<=` on both bounds); one millisecond after `term_end` → `403`. Cites: FR-061. Level: integration.
- **EC-31.** Rotation sweep boundary: a role with `term_end` exactly equal to `now + 7 days` is **not** flagged (`sweepRotation` skips when `role.termEnd.getTime() >= threshold`); a role one millisecond under that threshold **is** flagged. Cites: FR-062, DP-050. Level: integration.
- **EC-32.** `GET /governance-roles/actions/:actionRef/status` for an `action_ref` with zero approvals → `satisfied_approval_types: []`, `fully_approved: false` (empty-collection boundary). Cites: FR-061. Level: integration.
- **EC-33.** Exactly three approvals (one per required type, three distinct citizens) → `fully_approved: true`; a fourth approval from a new citizen duplicating an already-satisfied type → still `201`, `fully_approved` stays `true` with no regression. Cites: FR-061. Level: integration.
- **EC-34.** The first entry ever appended to a fresh chain has `prev_hash` equal to the fixed genesis constant (64 zero hex characters); `GET /audit/log/verify` on a single-entry chain → `valid: true`. Cites: FR-060. Level: integration.

### 4.5 Concurrency & idempotency

- **EC-35.** Two `POST /audit/log` calls with the same `idempotency_key` but different `payload` values → the second call returns the **same** entry as the first (first payload wins); exactly one entry is stored (`Store.Append`'s `idem` map). Cites: FR-060, DP-036. Level: integration.
- **EC-36.** Twenty concurrent `POST /audit/log` calls (no `idempotency_key`) against the live HTTP server all succeed with no lost or duplicated entries, and `GET /audit/log/verify` afterward still returns `valid: true` — protected by the Go store's explicit `sync.RWMutex` (`store.go`). Cites: FR-060. Level: integration.
- **EC-37.** Two concurrent `POST /governance-roles/approvals` calls for the same citizen+`action_ref` — deterministically one succeeds (`201`) and the other is rejected (`409` already-submitted), not a genuine race: `submitApproval` is a plain synchronous function with no `await` inside it, so Node's single-threaded event loop runs each request handler invocation to completion before the next begins. Worth contrasting explicitly with `audit-service`'s Go store, which uses an *explicit* `sync.Mutex` because it faces real goroutine-level concurrency — `governance-role-service` has no equivalent explicit lock and currently relies on this incidental single-threaded property. Cites: FR-061. Level: integration.
- **EC-38.** Two concurrent `POST /governance-roles/actions/:actionRef/execute` calls on the same fully-approved+delayed+visible `action_ref` — the first executes (`executed: true`, `already_executed: false`, executor invoked once), the second observes the existing execution record and returns `already_executed: true` without re-invoking the executor or the gate checker (confirmed by `execution.test.ts`'s idempotency test); same "serialized by Node's event loop, no explicit lock" caveat as EC-37. Cites: FR-061, FR-065. Level: integration.
- **EC-39.** `audit-service`'s out-of-order/buffered chain-linking primitive (`Store.linkEntry`, the `pending` map keyed by claimed `prev_hash`) is never reached through any HTTP endpoint — `POST /audit/log` always computes its own `prev_hash` from the current tip server-side, always linking immediately. DP-036's documented async-queue semantics ("out-of-order arrivals are held until the predecessor is committed") is exercised only by `store_test.go`'s `TestStoreLinkEntryBuffersOutOfOrderThenFlushes`, a same-process direct-store test with no HTTP equivalent. `blocked on: no HTTP surface accepts an externally-computed prev_hash or an out-of-order entry — this may be an intentional consequence of the append-only design rather than a gap to close.` Cites: FR-060, DP-036. Level: integration (once unblocked, if ever).
- **EC-40.** For the same reason as EC-39, a genuine "chain-link doesn't match the current head" tamper attempt **cannot be produced through the public HTTP API at all** — every append is server-computed and self-consistent by construction (`Store.Append` always links to `tipRowHashLocked()`, never to a caller-supplied hash). `GET /audit/log/verify` on any chain built entirely through `POST /audit/log` will therefore always return `valid: true`; the only way this codebase has ever observed `valid: false` is by mutating `Store.entries` directly inside a same-process Go test (`chain_integrity_test.go`'s `TestVerifyChainIntegrityDetectsTamperedField`), which has no HTTP-reachable equivalent. Document this as a **positive integrity property** — tampering cannot occur via any client-reachable path today — rather than as an open edge case to close. Cites: FR-060, ADR-005. Level: integration.

### 4.6 Cross-service failure & degradation

- **EC-41.** A live `audit-service` being down, slow, or erroring has **no effect** on `governance-role-service`'s protocol-change execution today, because `protocolGateChecker` defaults to always-confirmed rather than calling `audit-service`'s real `POST /audit/protocol-changes/gate`. `blocked on: HttpProtocolGateChecker seam does not exist.` Cites: FR-065, FR-067, DP-043. Level: integration (once unblocked).
- **EC-42.** A live `competency-service` being down has **no effect** on approval submission, because `coiChecker` defaults to always-no-conflict. `blocked on: HttpCOIChecker seam / competency-service caller does not exist.` Cites: FR-063. Level: integration (once unblocked).
- **EC-43.** A live `governance-role-service` being down has **no effect** on identity suspend/revoke, because `approvalGate` defaults to always-true. `blocked on: HTTP ApprovalGate seam does not exist in identity-service.` Cites: FR-006, FR-007. Level: integration (once unblocked).
- **EC-44.** A live `audit-service` being down, slow, or erroring has **zero effect on any action** in `identity-service` or `governance-role-service` today — nothing waits, retries, or fails closed, since every `AuditEmitter` in both services defaults to a no-op. This directly undercuts FR-060's "all governance actions are written to an append-only log" at the system level, even though each service's own unit suite confirms its local emitter interface is invoked. `blocked on: HttpAuditEmitter production implementations needed in both services (and, per SRV-012, in every other service).` Cites: FR-060. Level: integration (once unblocked).
- **EC-45.** A live `civic-duty-service` being down has **no effect** on rotation off-boarding, because `replacementRequester.requestReplacement()` defaults to a no-op — a role flagged for off-boarding never actually gets a real replacement queued today regardless of `civic-duty-service`'s availability. `blocked on: HTTP ReplacementRequester seam / civic-duty-service caller does not exist.` Cites: FR-062, DP-050. Level: integration (once unblocked).

### 4.7 Data integrity & audit

- **EC-46.** `POST /audit/protocol-changes/gate` returning `released: false` (missing approvals, delay not elapsed, or not publicly visible) writes **no** audit-log entry — `GateProtocolExecution` only calls `s.store.Append` on the success path. A blocked/rejected high-impact execution attempt leaves no trace in the log at all, which is arguably itself governance-relevant under FR-060's "all governance-relevant actions" wording. Cites: FR-060, FR-065, DP-043. Level: integration.
- **EC-47.** Constitutional review's placeholder `keywordMatchAssessor` is a case-insensitive substring match of a protected right's `name` against the caller-supplied `change_summary` — trivially over-triggered (any unrelated mention of the right's name blocks the change) and trivially under-triggered (a paraphrase that never uses the name clears it). Document current behavior as-implemented; `service.go` itself comments this is "a placeholder trigger only." Cites: FR-060, FR-067. Level: integration.
- **EC-48.** Two or more concurrent `GET /audit/log` reads (simulating independent audit bodies, FR-066) while a writer concurrently appends all observe a consistent, monotonically-growing log with no torn reads (Go `sync.RWMutex`); concurrent `GET /audit/log/verify` calls return identical results to each other. Cites: FR-066. Level: integration.
- **EC-49.** `identity-service`'s `scanForDuplicates` writes exactly **one** aggregate audit event (`entity: "citizen"`, `entityId: "duplicate-scan"`, `action: "duplicates_flagged"`) per scan that finds any duplicates — not one event per flagged pair. The audit trail records that a scan flagged *something* but not *which* citizens, which weakens "publicly verifiable" traceability of DP-024/DP-056's actual findings. Cites: FR-001, FR-060, DP-024, DP-056. Level: integration.
- **EC-50.** `audit-service`'s HMAC signing key is generated fresh in memory at process start and never persisted (`store.go`/`chain.go`) — consistent with today's in-memory-only store (a restart loses the whole log anyway), but flagged as a forward-looking gap: a persistent deployment backed by a real database would need the signing key persisted or KMS-backed too, or every previously-signed entry would fail verification against a newly generated key after a restart. Cites: FR-060, ADR-005. Level: integration.
- **EC-51.** Nothing inside `audit-service` prevents a caller from putting ballot content into an append's `payload` — NFR-001's "ballot content is never logged" is enforced entirely by caller discipline today (no caller in this codebase currently does it), not by any validation inside `audit-service` itself. Cites: FR-060, DP-036. Level: integration.

---

## 5. Traceability

| Scenario | FR/DP/NFR ids | Level | Automated test id |
|---|---|---|---|
| HP-1 | FR-060,DP-036 | integration | TBD |
| HP-2 | FR-061,FR-065,FR-067,DP-023,DP-035 | e2e | TBD |
| HP-3 | FR-061 | integration | TBD |
| HP-4 | FR-062,DP-050 | integration | TBD |
| HP-5 | FR-001 | integration | TBD |
| HP-6 | FR-001,DP-024,DP-056 | integration | TBD |
| HP-7 | FR-066 | integration | TBD |
| EC-1 | FR-060 | integration | TBD |
| EC-2 | FR-060 | integration | TBD |
| EC-3 | FR-060 | integration | TBD |
| EC-4 | FR-060 | integration | TBD |
| EC-5 | FR-060 | integration | TBD |
| EC-6 | FR-062 | integration | TBD |
| EC-7 | FR-062 | integration | TBD |
| EC-8 | FR-061 | integration | TBD |
| EC-9 | FR-065 | integration | TBD |
| EC-10 | FR-001 | integration | TBD |
| EC-11 | FR-001 | integration | TBD |
| EC-12 | FR-061 | integration | TBD |
| EC-13 | FR-061 | integration | TBD |
| EC-14 | FR-061,FR-065 | integration | TBD |
| EC-15 | FR-065 | integration | TBD |
| EC-16 | FR-065,FR-067 | integration | TBD |
| EC-17 | FR-065,FR-067,DP-043 | integration | TBD |
| EC-18 | FR-006 | integration | TBD |
| EC-19 | FR-001,FR-006 | integration | TBD |
| EC-20 | DP-062,DP-063,DP-064 | integration | TBD |
| EC-21 | FR-061 | integration | TBD |
| EC-22 | FR-063 | integration | TBD |
| EC-23 | FR-061 | integration | TBD |
| EC-24 | FR-061 | integration | TBD |
| EC-25 | FR-061 | integration | TBD |
| EC-26 | FR-061,FR-067 | integration | TBD |
| EC-27 | FR-006,FR-007 | integration | TBD |
| EC-28 | FR-067 | integration | TBD |
| EC-29 | FR-061 | integration | TBD |
| EC-30 | FR-061 | integration | TBD |
| EC-31 | FR-062,DP-050 | integration | TBD |
| EC-32 | FR-061 | integration | TBD |
| EC-33 | FR-061 | integration | TBD |
| EC-34 | FR-060 | integration | TBD |
| EC-35 | FR-060,DP-036 | integration | TBD |
| EC-36 | FR-060 | integration | TBD |
| EC-37 | FR-061 | integration | TBD |
| EC-38 | FR-061,FR-065 | integration | TBD |
| EC-39 | FR-060,DP-036 | integration | TBD |
| EC-40 | FR-060,ADR-005 | integration | TBD |
| EC-41 | FR-065,FR-067,DP-043 | integration | TBD |
| EC-42 | FR-063 | integration | TBD |
| EC-43 | FR-006,FR-007 | integration | TBD |
| EC-44 | FR-060 | integration | TBD |
| EC-45 | FR-062,DP-050 | integration | TBD |
| EC-46 | FR-060,FR-065,DP-043 | integration | TBD |
| EC-47 | FR-060,FR-067 | integration | TBD |
| EC-48 | FR-066 | integration | TBD |
| EC-49 | FR-001,FR-060,DP-024,DP-056 | integration | TBD |
| EC-50 | FR-060,ADR-005 | integration | TBD |
| EC-51 | FR-060,DP-036 | integration | TBD |

---

## Status update (2026-08-27)

**EC-26 is resolved.** `submitApproval` now checks the approver role's `layer` against a fixed `REQUIRED_LAYER_BY_APPROVAL_TYPE` mapping (`citizen_supermajority`→citizen, `audit_confirmation`→audit, `body_endorsement`→protocol) using the `Layer` field ADR-001's four accountability layers already model on `GovernanceRole` — a role outside the required layer is rejected with 403. This ties the three required approval types to real, independent layers instead of accepting any active role for any type, closing the specific gap this doc identified. EC-26 can now be written as a real integration test asserting the 403.

Separately, proposal-service's own `AuditEmitter` is no longer a no-op (see ARCH-012/ARCH-020's status updates) — its status transitions now reach the real audit log, which is relevant context for EC-39/EC-44 even though this doc's primary subject (audit-service, governance-role-service, identity-service) is unchanged otherwise. The hash-chain-tamper-unreachable-via-HTTP finding (EC-39/EC-40) and every other seam-defaults-to-no-op finding in this doc still stand.
