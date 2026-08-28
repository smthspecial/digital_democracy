---
id: ARCH-010
type: arch
title: "Citizen identity registration & verification"
status: draft
linkedIds: EPIC-001,FR-001,FR-002,FR-003,FR-004,FR-005,FR-006,FR-007,ADR-019,ADR-014,AUTH-010
created: 2026-08-27
---

## Overview

This flow covers civic-identity registration through verification/activation, login and MFA (enrollment + step-up), and status transitions (suspend/revoke) gated by governance-role-service's multi-party approval. All three services in scope (`identity-service` :4001, `auth-service` :5004, `governance-role-service` :4009) have real, independently working HTTP surfaces today, but every cross-service edge between them is still a same-process seam stub: `identity-service`'s `ApprovalGate` always returns `true`, `auth-service`'s `/auth/login` trusts caller-supplied `citizen_status`/`credential_valid` instead of calling `identity-service`, and `identity-service`'s revoke path has no seam at all — not even a stub — for cascading session revocation to `auth-service` (DP-042). This test plan therefore depends on four new real HTTP-calling seam implementations that don't exist yet: `HttpApprovalGate` (identity-service → governance-role-service), `HttpIdentityStatusChecker` (auth-service → identity-service), a brand-new `SessionRevoker` (identity-service → auth-service, the one seam missing entirely), and `HttpCOIChecker` (governance-role-service → competency-service). Scenarios that depend on one are marked `blocked on:` per ARCH-009 §2.

---

## 1. Services & seams in scope

| Service | Role in this flow | Real HTTP call today or seam-stub today |
|---|---|---|
| `identity-service` (SRV-001, TS, `:4001`) | Owns citizen lifecycle: register, verify/activate, suspend, revoke, duplicate detection (DP-001, DP-002, DP-024, DP-042, DP-056) | Real: `POST /identity/citizens`, `GET /identity/citizens`, `GET /identity/citizens/:id`, `POST /identity/citizens/:id/verifications`, `POST /identity/citizens/:id/suspend`, `POST /identity/citizens/:id/revoke`, `POST /identity/duplicates/scan`. Stub: `ApprovalGate.hasRequiredApprovals(citizenId)` (`collaborators.ts`) defaults to always `true` — no real call to governance-role-service, and its signature carries no action type (see EC-7). Stub: `AuditEmitter.append()` is a no-op. **Gap, not stub**: no interface/seam of any kind exists yet for cascading a completed suspend/revoke to `auth-service`'s session revocation (DP-042's "invalidates... suspends active governance_role records" and the session-revocation part of the cascade is simply not wired — `revokeCitizen`'s comment says this is "owned by other services"). |
| `auth-service` (SRV-017, Go, `:5004`) | Session issuance/rotation, MFA enrollment, step-up challenges, anomaly detection, forced session revocation (DP-059, DP-060, DP-061, DP-066, DP-067) | Real: all `/auth/*` endpoints including `POST /auth/internal/validate` and `POST /auth/internal/revoke-all/{citizenID}` (the endpoint DP-042's cascade should call once `identity-service` gains a `SessionRevoker`). Stub: `citizen_status` and `credential_valid` on `POST /auth/login` are trusted, caller-supplied request fields — README.md states plainly "There is no live identity-service... integration yet." `AuditEmitter.Emit()` is a no-op. Credential verification itself (proving a citizen's government-linked credential, DP-059 step 1) has **no implementation anywhere in this codebase** — there is no credential-issuing/verifying service to call, so `credential_valid` cannot be closed the way the other three seams can; it stays `blocked on: no credential verification system exists` for the life of this doc. |
| `governance-role-service` (SRV-011, TS, `:4009`) | Multi-party approval coordination for identity suspend/revoke (DP-023, DP-035) | Real: `POST /governance-roles/roles`, `POST /governance-roles/approvals`, `GET /governance-roles/actions/:actionRef/status`, `POST /governance-roles/actions/:actionRef/execute`. Stub: `COIChecker.hasConflict()` (`collaborators.ts`) always returns `false` — no real competency-service call. `AuditEmitter.emit()` is a no-op. **Gap**: `POST /governance-roles/approvals` and the status/execute endpoints perform no session or MFA-tier check at all today — no `Authorization` header handling exists in `routes/approvals.ts` — despite AUTH-010 requiring T3 for `approval:submit:operator`/`approval:submit:council`. |

---

## 2. Preconditions & fixtures

All fixtures are built through each service's own public API — never by writing into another service's in-memory store directly.

- **Pending citizen**: `POST /identity/citizens {public_handle, raw_legal_identifier}` (DP-001) → `status: pending`.
- **Active citizen**: pending citizen, then `POST /identity/citizens/:id/verifications {evidence_ref, outcome: "verified"}` (DP-002) → `status: active`.
- **Duplicate-signal pair**: two citizens registered with different `raw_legal_identifier` values (so the synchronous exact-hash check at registration doesn't block either) but public handles that normalize to the same string (e.g. `"Alice"` / `" alice "`) — surfaced only by `POST /identity/duplicates/scan`'s `signal_matches`, not at registration time.
- **Duplicate-hash pair**: two `POST /identity/citizens` calls with the identical `raw_legal_identifier` — the second is rejected synchronously with `409` before a second citizen record ever exists, so this fixture is used to prove rejection, not to seed a pair for later review.
- **Three independent approvers**: `POST /governance-roles/roles` × 3, one per distinct `citizen_id`, `term_start ≤ now ≤ term_end`, any `role_type` (the approval-type distinction, not the role-type, is what governance-role-service enforces).
- **Action-ref convention**: this doc adopts `identity:suspend:{citizenId}` and `identity:revoke:{citizenId}` as the `action_ref` values submitted to governance-role-service for identity actions, since no existing spec document defines one. See EC-7 for why this convention matters.
- **Fully-approved identity action**: three approvers above, then `POST /governance-roles/approvals` × 3 against the chosen `action_ref`, one per `approval_type` (`citizen_supermajority`, `audit_confirmation`, `body_endorsement`), each from a different `citizen_id` — then `GET /governance-roles/actions/{action_ref}/status` returns `fully_approved: true`.
- **T1 session**: `POST /auth/login {citizen_id, citizen_status: "active", credential_valid: true, device_fingerprint, ip_subnet}` (DP-059) → session at `assurance_tier: T1`.
- **T2/T3 session**: T1 session, then `POST /auth/factors {citizen_id, session_id, factor_type, ...proof}` (DP-060) → session upgraded to `T2` (TOTP) or `T3` (passkey/facial).

---

## 3. Happy path scenarios

### HP-1 — Register, verify, activate, log in, enroll MFA
Services: identity-service, auth-service. Level: **e2e**.

1. `POST /identity/citizens` (identity-service) — DP-001 — citizen created, `status: pending`.
2. `POST /identity/citizens/:id/verifications {outcome: "verified"}` (identity-service) — DP-002 — citizen transitions to `active`.
3. `POST /auth/login` (auth-service), with `citizen_status` resolved via `HttpIdentityStatusChecker`'s real `GET /identity/citizens/:id` call against the citizen from step 2 (not caller-asserted) — DP-059 — session issued at `assurance_tier: T1`, `requires_step_up: false`, `available_factor_types: []` (zero factors enrolled).
4. `POST /auth/factors {factor_type: "totp"}` (auth-service) — DP-060 — `mfa_factor` row created (`status: active`), session upgraded to `assurance_tier: T2`.

End state: citizen `active`; one `mfa_factor` (`totp`, `active`); session `T2`; `auth_event` rows for `login_success` and `factor_enrolled`.
Blocked on: `HttpIdentityStatusChecker` (step 3's real cross-service call).

### HP-2 — Step up to T3 for a high-assurance action
Services: identity-service, auth-service. Level: **e2e**.

1. Continue from HP-1's T2 session.
2. `POST /auth/factors {factor_type: "passkey"}` (auth-service) — DP-060 — session upgraded to `assurance_tier: T3`, `last_mfa_at` set.
3. Simulate elapsed time within the 5-minute T3 window; `POST /auth/stepup {tier: "T3", factor_type: "passkey"}` (auth-service) — DP-061 — succeeds, new access token issued, `stepup_success` event recorded.
4. Confirm via `HttpIdentityStatusChecker` that the citizen backing this session is still `active` in identity-service at the moment of step-up (a step-up for a citizen concurrently revoked by governance-role-service approval should be rejected — see EC-6).

End state: session `T3`, `last_mfa_at` within window; identity-service citizen record unchanged (`active`).
Blocked on: `HttpIdentityStatusChecker`.

### HP-3 — Duplicate signal detected, reviewed, and resolved by suspension
Services: identity-service, governance-role-service. Level: **e2e**.

1. Register and activate citizen A (`public_handle: "alice"`) — DP-001, DP-002.
2. Register and activate citizen B (`public_handle: " Alice "`, different `raw_legal_identifier`) — DP-001, DP-002.
3. `POST /identity/duplicates/scan` (identity-service) — DP-024/DP-056 — `signal_matches` includes `{citizen_id_a: A, citizen_id_b: B}`; `hash_matches` empty.
4. Create three independent governance roles, submit three approvals against `identity:suspend:{B}` — DP-023 (governance-role-service).
5. `GET /governance-roles/actions/identity:suspend:{B}/status` — DP-035 — `fully_approved: true`.
6. `POST /identity/citizens/{B}/suspend` (identity-service), with `ApprovalGate` now backed by `HttpApprovalGate`'s real call to step 5's endpoint — DP-042 (status-flip portion) — citizen B → `status: suspended`.

End state: citizen A `active`; citizen B `suspended`; three `approval` rows in governance-role-service tied to `identity:suspend:{B}`; identity-service audit event `citizen: suspended` for B.
Blocked on: `HttpApprovalGate`.

### HP-4 — Full revocation with multi-approval and session cascade
Services: identity-service, governance-role-service, auth-service. Level: **e2e**.

1. Register, verify/activate, and log in a citizen (T1 session issued) — DP-001, DP-002, DP-059.
2. Three independent governance roles submit three approvals against `identity:revoke:{citizenId}` — DP-023.
3. `GET /governance-roles/actions/identity:revoke:{citizenId}/status` — `fully_approved: true` — DP-035.
4. `POST /identity/citizens/{citizenId}/revoke` (identity-service, `HttpApprovalGate`-backed) — citizen → `status: revoked`; identity-service's new `SessionRevoker` seam calls `POST /auth/internal/revoke-all/{citizenId}` (auth-service) — DP-042.
5. `POST /auth/internal/validate` (auth-service) with the step-1 access token — token is rejected (session `status: revoked`, not `active`).

End state: citizen `revoked`; all of that citizen's sessions `revoked` in auth-service; identity-service audit event `citizen: revoked`; auth-service `auth_event` `session_revoked` for each affected session.
Blocked on: `HttpApprovalGate`, `SessionRevoker` (does not exist in any form today — see §1).

---

## 4. Edge cases

### Input validation

- **EC-1**: `POST /identity/citizens` with an empty/missing `public_handle` or `raw_legal_identifier` (schema `minLength: 1`, `additionalProperties: false`) → `400`; no downstream call to governance-role-service or auth-service occurs as a side effect. FR-001, FR-002. Level: integration.
- **EC-2**: `POST /governance-roles/approvals` with `approval_type` outside the 3-value enum, targeting an `identity:suspend:{id}`/`identity:revoke:{id}` action_ref → `400`; identity-service's suspend/revoke for that citizen remains blocked (approval never recorded, `fully_approved` never reached). FR-007. Level: integration.

### State-machine violations

- **EC-3**: Login for a citizen whose real identity-service status is `pending` (never verified) → once `HttpIdentityStatusChecker` exists, `403` `complete identity verification`, no session row created — DP-059 step 4. FR-002. Blocked on: `HttpIdentityStatusChecker`. Level: e2e.
- **EC-4**: Re-suspending an already-`revoked` citizen, or double-suspending an already-`suspended` one, once fresh approvals are (re-)obtained. **Expected** (per FR-006's defined revocation workflow): `409`, illegal transition rejected. **Actual gap found in code**: `suspendCitizen`/`revokeCitizen` (`services/identity.ts`) call `store.updateCitizenStatus` unconditionally once `hasRequiredApprovals` passes, with no check of the citizen's *current* status — a fully-approved re-suspend of a `revoked` citizen silently overwrites it back to `suspended`. This scenario should be written to fail against current code and tracked as a fix prerequisite, not silently dropped. FR-006. Level: integration.
- **EC-5**: `POST /auth/refresh` for a session that identity-service's revoke cascade already force-revoked (HP-4, step 4/5) → `401` (auth-service's own `sess.Status != SessionActive` check in `RefreshToken`), proving the cascade's effect is durable at the session boundary even without re-querying identity-service. FR-006, DP-042. Blocked on: `SessionRevoker`. Level: e2e.
- **EC-6**: `POST /auth/stepup` on a session already force-revoked by the same cascade → `403` `session is revoked` (`CompleteStepUp`'s explicit `SessionRevoked` check). FR-006, ADR-014. Blocked on: `SessionRevoker`. Level: e2e.

### Authorization / eligibility

- **EC-7**: `ApprovalGate.hasRequiredApprovals(citizenId)`'s signature carries no action type. Once backed by a real HTTP call, a fully-approved *suspend* action's `fully_approved: true` result would also read `true` for a subsequent, entirely unapproved *revoke* attempt on the same citizen unless `HttpApprovalGate` is built to pass an action-scoped ref (this doc's `identity:suspend:{id}` / `identity:revoke:{id}` convention, §2) all the way from route → service → HTTP call. Flag as a design gap the seam implementation must close before this scenario can pass; write the test to assert suspend-approval does *not* satisfy a revoke check on the same citizen. FR-007. Level: integration.
- **EC-8**: An approver with an active domain COI (once `COIChecker` is wired to competency-service instead of its always-`false` default) is excluded from satisfying `identity:suspend:{id}`/`identity:revoke:{id}` approvals — confirms SRV-011's "citizen with a COI in the affected domain is automatically excluded" rule holds for identity actions, not only protocol changes. FR-007. Blocked on: `HttpCOIChecker`. Level: integration.
- **EC-9**: A governance role whose `term_end` passes *after* its approval was submitted but *before* `fully_approved` is checked. `submitApproval` validates `isRoleActive` only at write time; `getActionStatus` does not re-validate role activity at read time — so a now-term-expired approver's earlier approval still counts toward `fully_approved`. Document as expected (spec intent: only currently-valid-term approvals should count) vs. actual (any previously-accepted approval counts regardless of later expiry). FR-007, ADR-011. Level: integration.

### Threshold & boundary conditions

- **EC-10**: Exactly 2-of-3 approval types satisfied (one short of full) → `GET /governance-roles/actions/{action_ref}/status` reports `fully_approved: false`; identity-service's suspend/revoke still returns `403` even with a two-thirds majority — the one-under-threshold case FR-007 exists to guarantee. Level: integration.
- **EC-11**: `POST /identity/duplicates/scan` against zero registered citizens → `200` with empty `hash_matches`/`signal_matches`, no `duplicates_flagged` audit event (only fired when a match exists) — zero/empty-population boundary. FR-001. Level: integration.
- **EC-12**: `POST /governance-roles/approvals` has no session or MFA-tier check at all today, despite AUTH-010 requiring `T3` for `approval:submit:operator`/`approval:submit:council`. Once wired, submitting an approval at exactly `last_mfa_at` = 5 minutes (T3 boundary) should succeed; one second past should be rejected with a step-up-required signal. Currently **unenforceable** — no `Authorization` header handling exists in `routes/approvals.ts` at all, so this is a real gap, not a stub: any caller who knows an active `approver_role_id` can submit an approval with no session token whatsoever. FR-007, ADR-014, AUTH-010. Blocked on: session/MFA-tier enforcement not implemented in governance-role-service's approval endpoint. Level: integration.

### Concurrency & idempotency

- **EC-13**: Two concurrent `POST /identity/citizens` requests with the identical `raw_legal_identifier`. `registerCitizen`'s check-then-write (`findCitizenByLegalHash` then `insertCitizen`, `services/identity.ts`) has no atomic guard between the two; document a concurrency test asserting the FR-001 invariant (at most one citizen per legal hash) holds — today it holds only because the function body has no `await` between check and write inside Node's single-threaded event loop, not because of an explicit uniqueness constraint. A future async/DB-backed store would need a real one. FR-001. Level: integration.
- **EC-14**: Two concurrent forced-revocation cascade calls for the same citizen (e.g. a retried `SessionRevoker` call after a timed-out first attempt) — `RevokeAllSessions` (auth-service) is naturally idempotent (`if sess.Status == SessionRevoked { continue }`), so the second call returns `count: 0` without error. FR-006, DP-042. Blocked on: `SessionRevoker`. Level: e2e.
- **EC-15**: Replay of an already-succeeded `/suspend` or `/revoke` call (e.g. a client retry after a dropped response). Current code has no idempotency key; the retried call re-checks `hasRequiredApprovals` (still `true`, since approval records persist) and reapplies the same status update — net-idempotent on `status`, but re-emits a second `audit.append` `"suspended"`/`"revoked"` event for what is, from the citizen's perspective, one transition, double-counting the audit trail (see EC-20). FR-005, FR-006. Level: integration.

### Cross-service failure & degradation

- **EC-16**: `POST /identity/citizens/:id/suspend` or `/revoke` when governance-role-service is unreachable (timeout/connection refused), once `HttpApprovalGate` exists — must fail closed (`403`/`503`), not default to "approved" the way today's permissive stub (`hasRequiredApprovals: () => true`) does. This is the single highest-priority scenario in this document: a fail-open default here would silently defeat FR-007's entire no-unilateral-disable guarantee. Blocked on: `HttpApprovalGate`. Level: integration.
- **EC-17**: `POST /auth/login` when identity-service is unreachable, once `HttpIdentityStatusChecker` exists — must fail closed (no session issued), not default to treating an unreachable identity-service as `active`. FR-001, FR-002. Blocked on: `HttpIdentityStatusChecker`. Level: integration.
- **EC-18**: identity-service's revoke cascade when auth-service is unreachable, once `SessionRevoker` exists — the citizen's `status` write to `revoked` must still succeed (identity-service's own source-of-truth transition must not be blocked by a downstream outage), but the failed session-revocation call must be retried or durably logged, not silently dropped — a `revoked` citizen with a still-`active`, un-revoked session is a live security gap that directly contradicts FR-006 ("a revoked identity can no longer participate"). Blocked on: `SessionRevoker` — the one seam in this flow with no interface or stub of any kind today. Level: integration.
- **EC-19**: All three services' `AuditEmitter`/audit-emit calls when a real audit-service is unreachable. Today this is moot — every emitter is a no-op that cannot fail. Once real: does the citizen-facing action (register/verify/suspend/revoke/login/enroll/step-up) still complete, or fail closed? FR-005 requires every creation/status event to be durably auditable; an action that "succeeds" with a silently-dropped audit call breaks that guarantee. Blocked on: real audit-service HTTP integration in all three services. Level: integration.

### Data integrity & audit

- **EC-20**: End-to-end audit trail for a full suspend cycle spans two services (governance-role-service's three `approval.recorded` events + identity-service's `citizen: suspended` event). Once both emit to a real audit-service, the entries must be correlatable (e.g. by shared `action_ref`/`citizenId`) without either payload including the raw legal identifier (identity-service already guarantees this — see its own "never leaks the raw legal identifier" unit tests) or any approver's vote content beyond `decision`. FR-005, FR-007. Level: integration.
- **EC-21**: Ballot-identity separation boundary (FR-003, FR-004). Neither identity-service's `Citizen`/`IdentityVerification` types (`domain/types.ts`) nor auth-service's `Session`/`AuthEvent`/`MFAFactor` structs (`domain.go`) carry any field resembling `eligibility_token_id` or `vote_session_id` today — confirmed by reading both. This constraint currently holds by omission; the integration/e2e suite should assert the audit payload and session-record *shape* stays free of any such field as a regression guard, since voting-service (ARCH-016, out of scope here) will eventually need to call into these two services for eligibility checks without creating a link back to a ballot. FR-003, FR-004. Level: integration.
- **EC-22**: A suspended or revoked citizen record remains readable via `GET /identity/citizens/:id` — never hard-deleted (`store.ts` has no delete path; `updateCitizenStatus` only mutates `status`) — so FR-006's "documented justification and is logged" requirement stays inspectable after the fact. FR-006. Level: integration.
- **EC-23**: A session-level anomaly (e.g. device/IP mismatch on `/auth/refresh`, or MFA brute-force lockout) suspends only the affected `session` row in auth-service — it must **not** change the citizen's `status` in identity-service. Verify `GET /identity/citizens/:id` still returns `active` throughout an anomaly-suspend-and-T3-recovery cycle, confirming DP-066's response is correctly scoped to the session layer and does not cross into identity-service's authority (which requires the separate, multi-approved DP-042 path to change citizen status). FR-006, FR-007, ADR-014. Level: integration.

---

## 5. Traceability

| Scenario | FR/DP/NFR ids | Level | Automated test id |
|---|---|---|---|
| HP-1 | FR-001,FR-002,DP-001,DP-002,DP-059,DP-060 | e2e | TBD |
| HP-2 | FR-002,DP-060,DP-061,ADR-014 | e2e | TBD |
| HP-3 | FR-001,FR-005,FR-007,DP-024,DP-056,DP-023,DP-035,DP-042 | e2e | TBD |
| HP-4 | FR-005,FR-006,FR-007,DP-023,DP-035,DP-042,DP-059 | e2e | TBD |
| EC-1 | FR-001,FR-002 | integration | TBD |
| EC-2 | FR-007 | integration | TBD |
| EC-3 | FR-002,DP-059 | e2e | TBD |
| EC-4 | FR-006 | integration | TBD |
| EC-5 | FR-006,DP-042 | e2e | TBD |
| EC-6 | FR-006,ADR-014 | e2e | TBD |
| EC-7 | FR-007 | integration | TBD |
| EC-8 | FR-007 | integration | TBD |
| EC-9 | FR-007,ADR-011 | integration | TBD |
| EC-10 | FR-007 | integration | TBD |
| EC-11 | FR-001 | integration | TBD |
| EC-12 | FR-007,ADR-014,AUTH-010 | integration | TBD |
| EC-13 | FR-001 | integration | TBD |
| EC-14 | FR-006,DP-042 | e2e | TBD |
| EC-15 | FR-005,FR-006 | integration | TBD |
| EC-16 | FR-007 | integration | TBD |
| EC-17 | FR-001,FR-002 | integration | TBD |
| EC-18 | FR-006 | integration | TBD |
| EC-19 | FR-005 | integration | TBD |
| EC-20 | FR-005,FR-007 | integration | TBD |
| EC-21 | FR-003,FR-004 | integration | TBD |
| EC-22 | FR-006 | integration | TBD |
| EC-23 | FR-006,FR-007,ADR-014 | integration | TBD |

---

## Status update (2026-08-27)

Two of the four seams this doc's Overview flagged as needed are now real:

1. **`auth-service` no longer trusts caller-supplied `citizen_status`.** `POST /auth/login` resolves it itself via a new `IdentityChecker` interface (`service.go`), with a real HTTP-calling implementation (`httpIdentityChecker` in `remote.go`, calling `GET /identity/citizens/:id`) wired in by `main.go` when `IDENTITY_SERVICE_URL` is set. The default, unconfigured checker **fails closed** — an unresolved status denies login rather than defaulting to active — so a client can no longer spoof `citizen_status: "active"` for a suspended or revoked citizen (regression-tested directly: `TestHandleLoginIgnoresClientSuppliedStatus`, `TestHandleLoginNoIdentityConfiguredFailsClosed`). `credential_valid` remains caller-supplied, unchanged: no credential-verification system exists anywhere in this codebase to call instead, so that half of the Overview's gap is still `blocked on: no credential verification system exists`, as originally noted.
2. **`identity-service`'s missing `SessionRevoker` seam now exists.** `suspendCitizen` and `revokeCitizen` (`services/identity.ts`) both call it after their status flip and audit emit; the real implementation (`createHttpSessionRevoker` in `collaborators.ts`) calls `POST /auth/internal/revoke-all/:citizenId`, wired in by `index.ts` when `AUTH_SERVICE_URL` is set. A suspension or revocation now actually terminates the citizen's live sessions instead of leaving them valid until their own TTL lapses. EC-5/EC-14 (the DP-042 session-cascade scenarios) can now be written for real.

Still open: `identity-service`'s `ApprovalGate` is still an always-`true` stub (governance-role-service isn't called), so EC-7's action-type gap and the multi-approval scenarios remain as originally described.
