---
id: ARCH-022
type: arch
title: "Platform reliability, scale & security operations"
status: draft
linkedIds: EPIC-013,NFR-009,NFR-011,AUTH-011,AUTH-012,AUTH-010,AUTH-006,ADR-001,ADR-014,ADR-015,ADR-016,ADR-017,ADR-018,ARCH-006,ARCH-007,ARCH-008,ARCH-009,DP-066,DP-067,DP-068,SRV-017
created: 2026-08-27
---

## Overview

This document is the ARCH-009-governed test plan for EPIC-013 (Platform Reliability, Scale & Security Operations). Per ARCH-009 §7 it differs in kind from ARCH-010 through ARCH-021: it does not specify one citizen-facing business journey, but two unrelated operational concerns — (a) the access-control behavior that keeps infrastructure authority separate from civic-ledger authority (AUTH-011, AUTH-012, DP-066/067/068), and (b) the resilience/scale behavior the deployed topology in ARCH-006/007/008 must exhibit (regional failover, national-vote-close surge capacity). It follows ARCH-009's environment approach (§2), edge-case taxonomy (§3), and traceability convention (§4); load/performance testing methodology stays owned by ARCH-007 and DR/failover *execution tooling* stays out of scope per ARCH-009 §6 — this document defines what must be verified, not how a drill or a load-generation harness is built.

**What is actually testable today, and what is not, splits cleanly along one line: whether real production code exists to exercise.**

- **auth-service (SRV-017, Go)** is a real, booting, stdlib-only HTTP service (`services/go/auth-service/`) that implements the full session lifecycle, MFA enrollment, step-up authentication, and anomaly detection/suspension described by DP-059, DP-060, DP-061, DP-066, and DP-067, entirely in-memory. Every scenario in §3 grounded in auth-service is testable today by booting the real service (as an `httptest.Server`, per ARCH-009 §2) and driving its real `/auth/*` HTTP surface — no invented behavior, only what `service.go`, `handlers.go`, and `store.go` actually validate and reject.
- **governance-role-service (SRV-011, TS)**, which owns `governance_role` (TBL-032) and `approval` (TBL-033) — the tables AUTH-011's standing appointment and DP-068's break-glass elevation are built on — exists as a real, booting Fastify service today, but only as **generic** role/approval CRUD (`POST /governance-roles/roles`, `POST /governance-roles/approvals`, action-status lookup). None of AUTH-011's or DP-068's *specific* business rules are implemented in that code yet: nothing rejects a citizen holding both `operator` and `platform_operator` simultaneously, nothing enforces DP-068's 4-hour break-glass term cap, nothing implements the dual-control "two independent platform-operators" approval type DP-068 substitutes for the standing three-type set, and nothing auto-enqueues the mandatory post-incident audit review DP-068 step 5 requires. This is a real gap surfaced by reading `services/roles.ts` and `services/approvals.ts`, not an assumption — §3's "Authorization / eligibility" subsection documents each gap individually rather than glossing over it, because a false "testable today" label here would be worse than an honest "not yet."
- **Regional failover, autoscaling under a national vote-close surge, quarterly DR drills, and chaos engineering** (§4) are specified entirely against the deployment topology ARCH-006 describes and the capacity plan ARCH-007 sets targets for — three-region Kubernetes clusters, per-region Kafka via Strimzi with cross-region MirrorMaker 2, cross-region Postgres replicas, HPA/KEDA/cluster-autoscaler, GeoDNS/anycast edge routing. None of that exists in this repository: every service (17 of them, per the root `README.md`) runs as a single in-process instance today, CI (`.github/workflows/ci.yml`) builds and tests each service independently with no docker-compose or Kubernetes harness, and auth-service's own README is explicit that its store is in-memory, single-instance. §4's scenarios are therefore forward-looking acceptance criteria — what the deployed system must do once ARCH-006's topology exists — not runnable tests against anything in this codebase today.

---

## 1. Services & seams in scope

| Service | Role in this flow | Status today |
|---|---|---|
| auth-service (SRV-017, Go) | Session issuance/rotation, MFA enrollment, step-up challenge, anomaly detection & suspension, expired-session purge (DP-059/060/061/066/067) | **Real HTTP call today.** Boots as a real process; every route in `router.go` is live and backed by real validation/crypto logic (`crypto.go`: RFC 6238 TOTP, ECDSA P-256 passkey verify, cosine-similarity facial match with mandatory liveness, AES-256-GCM at rest, sha256 token hashing). |
| governance-role-service (SRV-011, TS) | `governance_role` (TBL-032) and `approval` (TBL-033) records; standing platform-operator appointment (DP-063) and break-glass elevation (DP-068) | **Partial — real HTTP call for generic CRUD, seam gap for the epic's specific rules.** `POST /governance-roles/roles` and `POST /governance-roles/approvals` are real and booting, but enforce none of AUTH-011's mutual-exclusion rule or DP-068's dual-control substitution, 4-hour cap, or mandatory-review side effect. See Overview and §3.3. |
| identity-service (SRV-001, TS) | `citizen.status` lookup consulted before session issuance; consumer of auth-service's forced-revocation endpoint on identity suspension (DP-042) | **Seam-stub today.** auth-service's `Login` trusts `citizen_status` and `credential_valid` as explicit caller-supplied request fields (`handlers.go`, `domain.go` comment) rather than calling identity-service; identity-service has no outbound call into `POST /auth/internal/revoke-all/{citizenID}` yet (confirmed: no reference to that path or to auth-service in `services/ts/identity-service/src`). |
| notification-service (SRV-015, TS) | Citizen notification on anomaly detection (DP-066 step 6) | **Seam-stub today.** auth-service's only cross-cutting hook is the `AuditEmitter` interface (`service.go`); the default wired in `main.go` is `noopAuditEmitter` — no notification dispatch happens. |
| audit-service (SRV-012, Go) | `audit.append` consumer for every `auth_event` row, break-glass grant/revocation events, DR drill publication | **Seam-stub today.** Same `AuditEmitter` no-op as above — every `recordEvent` call in `service.go` invokes `audit.Emit(e)`, but nothing carries that event to a real audit-service instance yet. |
| Multi-region Kubernetes topology (all 17 services, ARCH-006) | Regional failover, autoscaling (HPA/KEDA/cluster-autoscaler), cross-region Postgres/Kafka replication, GeoDNS edge | **Not-yet-deployable.** No Terraform/Helm apply target in this repo stands up the ARCH-006 topology; `infra/` is IaC skeleton, not a running environment. |

---

## 2. Preconditions & fixtures

**For §3's auth-service scenarios:** boot the real auth-service binary (or an `httptest.Server` wrapping `newRouter`) on an ephemeral port, per ARCH-009 §2. Because `citizen_status`/`credential_valid` are trusted request fields rather than a live identity-service lookup, no other service needs to be running to build any fixture in §3.1–§3.7 (aside from §3.6's cross-service-failure items, which are about the absence of that lookup, not a precondition for it). Build every fixture through the real API, exactly as auth-service's own unit tests do: `POST /auth/login` to get a T1 session, `POST /auth/factors` to enroll a TOTP/passkey/facial factor and reach T2/T3, `POST /auth/stepup` to exercise step-up and brute-force accumulation, `POST /auth/refresh` to exercise rotation/reuse/mismatch detection, and the cron-equivalent `POST /auth/internal/purge-sessions` to exercise DP-067 directly rather than waiting on a real hourly scheduler.

**For §3.3's governance-role-service scenarios:** boot `buildServer()` on an ephemeral port. Fixtures for the *generic* scenarios (role creation, approval submission, term-active checks, COI rejection, duplicate-approval conflict) are buildable through the real API today. Fixtures for the DP-068-*specific* scenarios (mutual exclusion, break-glass dual-control substitution, 4-hour cap, auto-enqueued review) **cannot** be built through the public API at all — not because the fixture is hard to construct, but because the API has no shape for them yet (no `approval_type` value represents "two independent platform-operator co-approvals", no request flags a role creation as break-glass rather than standing). This is the ARCH-009 §2 fixture principle ("through each service's own public API, not by reaching into another service's store") running into a wall the underlying code hasn't built a door in yet.

**For §4's forward-looking scenarios:** would require, at minimum — three regional Kubernetes clusters with the namespace/mesh/`NetworkPolicy` layout in ARCH-006 §1–§3; a Strimzi Kafka cluster per region with MirrorMaker 2 replication of `audit.append` (ARCH-006 §4); cross-region Postgres replicas per service (ARCH-006 §5); HPA/KEDA/cluster-autoscaler wired to real metrics (ARCH-006 §7); GeoDNS/anycast edge routing (ARCH-006 §2); and a load-generation harness capable of the throughput ARCH-007 §3 specifies (~2,000 ballot-casts/sec sustained, ~5,000/sec burst, shaped to concentrate near a vote-close deadline). None of this exists in the repository today.

---

## 3. Scenarios: testable today (auth-service session/credential behavior)

### 3.0 Happy paths

| ID | Scenario | Cites |
|---|---|---|
| HP-1 | Citizen with valid credentials, active status, no enrolled factors logs in; receives a T1 session, `requires_step_up=false`, empty factor list | DP-059, ADR-014 |
| HP-2 | Citizen enrolls a TOTP factor with a valid code; factor is created active, session tier upgrades T1→T2, `login_success`/`factor_enrolled` audit events recorded | DP-060, ADR-014 |
| HP-3 | Citizen with an enrolled passkey completes T3 step-up with a valid challenge/signature; session tier upgrades to T3, access token rotates | DP-061, ADR-014, AUTH-010 |
| HP-4 | Citizen refreshes from the same device/subnet before expiry; both access and refresh tokens rotate, old refresh hash is retired into the reuse-detection index | DP-059, ADR-014 |
| HP-5 | Citizen logs out; session flips to `revoked`, refresh token hash zeroed, `session_revoked` event recorded | DP-059, ADR-014 |
| HP-6 | A session suspended for anomaly is restored to `active` by a fresh T3 step-up (facial or passkey) | DP-066 step 7 |
| HP-7 | An expired, never-revoked session past its 24h grace window is purged by DP-067; a `revoked` session of any age is retained | DP-067, TBL-037 |
| HP-8 | A `platform_operator`-typed `governance_role` row is created via governance-role-service's real API and is retrievable by `citizen_id` | AUTH-011, TBL-032 |
| HP-9 | Two independent role holders each submit one of the three required approval types for the same `action_ref`; `getActionStatus` reports `fullyApproved=true` once all three are satisfied | DP-035, TBL-033 |

### 3.1 Input validation

| ID | Scenario | Cites |
|---|---|---|
| EC-1 | Login with `credential_valid=false` → 401, `login_failure` event recorded regardless of `citizen_status` | DP-059 |
| EC-2 | Login with `citizen_status=pending` → 403 "complete identity verification", not a generic auth failure | DP-059 |
| EC-3 | Login with `citizen_status` = suspended, revoked, or an unrecognized string → uniform 401 "authentication failed" with no detail distinguishing which — verifies no status-leaking error message | DP-059, NFR-007 |
| EC-4 | Malformed JSON body on any of `/auth/login`, `/logout`, `/refresh`, `/factors`, `/stepup`, `/internal/validate` → 400 "invalid request body" | SRV-017 |
| EC-5 | Enroll TOTP with missing `totp_secret` or `totp_code` → 400 validation error | DP-060 |
| EC-6 | Enroll TOTP with a code that fails RFC 6238 validation (outside the ±1 step drift window) → invalid proof, no factor created | DP-060 |
| EC-7 | Enroll passkey missing any of public key / challenge / signature / credential ID → 400 validation error | DP-060 |
| EC-8 | Enroll passkey whose signature does not verify against the supplied public key → invalid proof, no factor created | DP-060 |
| EC-9 | Enroll facial with `liveness=false` → 403 "liveness check failed", rejected even if the embedding would otherwise match — liveness is checked before similarity, not as a tiebreaker | DP-060, SRV-017 key rule |
| EC-10 | Enroll facial with cosine similarity below the 0.85 confidence threshold → invalid proof, no factor created | DP-060 |
| EC-11 | Enroll with an unrecognized `factor_type` string → 400 validation error | DP-060 |
| EC-12 | Step-up requesting a tier that is neither T2 nor T3 → 400 validation error | DP-061 |
| EC-13 | Step-up requesting T3 with `factor_type=totp` → 400 "T3 requires a passkey or facial factor" — TOTP alone cannot satisfy T3 | DP-061, SRV-017 key rule |

### 3.2 State-machine violations

| ID | Scenario | Cites |
|---|---|---|
| EC-14 | Enroll factor against a `session_id` that doesn't exist → 404 session not found | DP-060 |
| EC-15 | Enroll factor with a `session_id` that exists but belongs to a different `citizen_id` → 403 "session does not belong to this citizen" | DP-060 |
| EC-16 | Step-up attempted on a session already `status=revoked` → 403 "session is revoked" — a revoked session can never be stepped up back to active | DP-061, TBL-037 |
| EC-17 | Step-up for a `factor_type` the citizen has no *active* (non-revoked) factor of → 403 "no active factor of that type enrolled" — a previously revoked factor of that type does not count | DP-061, TBL-038 |
| EC-18 | Refresh presented against a session that is `suspended` (not `active`) → generic authentication-failed, no further detail | DP-059, DP-066 |
| EC-19 | Logout called twice on the same `session_id` → second call is a no-op 200 "ok", not an error — idempotent by design, distinct from a rejected double-action | DP-059 |
| EC-20 | `ValidateAccessToken` presented with a token from a `suspended` session → rejected even though the token's own TTL hasn't elapsed — session status gates every authenticated call, not just token expiry | ADR-014, SRV-017 |

### 3.3 Authorization / eligibility

| ID | Scenario | Cites |
|---|---|---|
| EC-21 | `revoke_all_sessions` called for a citizen with zero active sessions → `count=0`, not an error — "nothing to revoke" is distinct from failure | SRV-017 |
| EC-22 | A citizen's own logout of one session must not revoke that citizen's other concurrent sessions — only `revoke_all_sessions` (DP-035-triggered forced revocation) has that blast radius | DP-059, DP-035 |
| EC-23 | Submitting an approval whose `approver_role_id` references no existing `governance_role` → 404 not found | TBL-033 |
| EC-24 | Submitting an approval from a role whose term has not started, or has already ended (`isRoleActive` check against `term_start`/`term_end`) → 403 forbidden — a lapsed or not-yet-active role cannot approve | TBL-032, DP-035 |
| EC-25 | Submitting an approval where the COI checker flags a conflict of interest for that citizen against that `action_ref` → 403 forbidden | DP-035, ADR-001 |
| EC-26 | The same citizen submitting a second approval for an `action_ref` they already approved → 409 conflict — the one guard the current code has against a single actor supplying more than one of the required independent approval types | DP-035, ADR-001 |
| EC-27 | **Gap — not enforced by current code.** A citizen already holding a standing `operator` (AUTH-006) role has a `platform_operator` role created for them (or the reverse) via `POST /governance-roles/roles`. AUTH-011 requires these be mutually exclusive; `services/roles.ts`'s `createRole` validates only `term_end > term_start`, nothing else — the request that AUTH-011 forbids currently succeeds. | AUTH-011, AUTH-006, ADR-001 |
| EC-28 | **Gap — not enforced by current code.** A `platform_operator` role is created with `term_end` more than 4 hours after `term_start`. DP-068 caps a break-glass grant's term at `term_start + 4h`; `createRole` has no notion of "this creation is a break-glass grant" to apply that cap to, and enforces no cap at all. | DP-068, AUTH-011 |
| EC-29 | **Gap — the scenario cannot even be constructed against current endpoints.** DP-068 substitutes dual real-time co-approval from a second, independent, on-call platform-operator for the standing three-type approval set. `ApprovalType` in `domain/types.ts` has exactly three values (`citizen_supermajority`, `audit_confirmation`, `body_endorsement`) and `getActionStatus`'s `fullyApproved` always requires all three — there is no approval type or code path representing two platform-operator co-approvals satisfying a break-glass action at all, so neither the happy path nor "grant requested without a second approver" is testable today. | DP-068, ADR-001, ADR-017 |
| EC-30 | **Gap — not enforced by current code.** DP-068 step 5 requires grant issuance to automatically enqueue a mandatory post-incident `audit_finding` review, due within 48 hours. No such side effect exists anywhere in `services/roles.ts`, `services/approvals.ts`, or `services/execution.ts`. | DP-068, AUTH-003 |

### 3.4 Threshold & boundary conditions

| ID | Scenario | Cites |
|---|---|---|
| EC-31 | Four step-up proof failures within the 10-minute window leave the session active (no anomaly yet); the fifth failure in that same rolling window suspends the session and records `anomaly_detected`/`mfa_brute_force` — verifies the threshold is "at 5", not "over 5" (`count >= bruteForceThreshold`) | DP-066, ADR-014 |
| EC-32 | A step-up failure timestamped just outside the trailing 10-minute window is pruned by `RecordFailure`'s cutoff and does not count toward the brute-force threshold; one timestamped just inside it does | DP-066 |
| EC-33 | Tier downgrade on refresh is gated by `now.Sub(sess.LastMFAAt) > tierT2ValidityWindow` (strictly greater than 12h) — a refresh at exactly 12h00m00s since last MFA does not yet downgrade; one moment later does | ADR-014, DP-059 |
| EC-34 | DP-067's purge boundary (`ExpiresAt.Add(purgeGracePeriod).Before(now)`) is a strict "before" — a session exactly at `expires_at + 24h` is not yet eligible; one moment past is | DP-067 |
| EC-35 | Facial-match cosine similarity exactly at the 0.85 threshold is accepted (`>=`); a value fractionally below is rejected | DP-060, DP-061 |
| EC-36 | A citizen with zero enrolled factors gets `requires_step_up=false` and an empty `available_factor_types` list at login, distinct from a citizen with exactly one enrolled factor | DP-059 |
| EC-37 | `revoke_all_sessions` against a citizen whose sessions are all already `revoked` returns `count=0` — the loop's `continue` on already-revoked rows prevents double-counting or re-emitting `session_revoked` for a row already in that terminal state | SRV-017 |

### 3.5 Concurrency & idempotency

| ID | Scenario | Cites |
|---|---|---|
| EC-38 | Two refresh calls race on the same refresh token: the first succeeds and rotates it; the second, now presenting a stale hash, is recognized via the `superseded` index as replay of an already-rotated token and triggers `token_reuse` anomaly + suspension, rather than silently succeeding twice | DP-066, DP-059 |
| EC-39 | Logout and refresh race on the same session: whichever the store commits first flips status to `revoked`; the other observes `Status != SessionActive` and fails with authentication-failed rather than completing against a half-updated session | DP-059 |
| EC-40 | Two concurrent "enroll TOTP" calls for the same citizen each independently validate and create their own factor row — `ActiveFactor`'s own code comment assumes "at most one active factor per type", which a race can violate; worth an explicit concurrency test given the store flags its own assumption | DP-060 |
| EC-41 | Two concurrent `submitApproval` calls for the same `action_ref` from two different role holders both succeed; a third, concurrently reusing one of those role holders' citizen identity, deterministically hits the "already submitted" conflict even under the race | DP-035 |

### 3.6 Cross-service failure & degradation

| ID | Scenario | Cites |
|---|---|---|
| EC-42 | **Not testable today — no real seam to fail.** `Login` trusts caller-supplied `citizen_status`/`credential_valid` instead of calling identity-service, so "identity-service is down/slow/erroring" has nothing to exercise until the real `HttpCitizenStatusChecker`-equivalent seam (ARCH-009 §2) is implemented. | ARCH-009 §2, SRV-017 |
| EC-43 | **Partially testable.** DP-066 step 6 (notify citizen via notification-service) and step 8 (flag account via identity-service) are both no-op collaborator seams. The auth-service-side state transition (session suspended, `anomaly_detected` recorded) is real and testable; whether the citizen is actually notified, or identity-service actually flags the account, is not — only "did auth-service reach the point where it would have called out" is verifiable today. | DP-066 |
| EC-44 | **Testable only at the seam boundary, not end to end.** Every `recordEvent` call invokes `AuditEmitter.Emit`; with the default `noopAuditEmitter` wired in `main.go`, nothing reaches a real audit-service. Testable today as "was `Emit` invoked with the correct `AuthEvent` payload" against an injectable test double; not testable as "did audit-service actually append the entry" until the real HTTP-calling `AuditEmitter` implementation exists. | DP-036, ARCH-009 §2 |

### 3.7 Data integrity & audit

| ID | Scenario | Cites |
|---|---|---|
| EC-45 | Every login attempt, success or failure, produces exactly one `auth_event` row of the correct `event_type` — the `fail()` closure in `Login` records the event before returning the error on every rejection path (invalid credentials, pending verification, suspended/revoked status) | DP-059, TBL-039 |
| EC-46 | An `anomaly_detected` event's `anomaly_reason` is always exactly one of the five DP-066 values (`new_device`, `new_country`, `concurrent_geos`, `mfa_brute_force`, `token_reuse`) and never blank | DP-066, TBL-039 |
| EC-47 | A step-up failure that does not cross the brute-force threshold still records a `stepup_failure` event — the audit trail captures every attempt, not only the ones with a state-machine side effect | DP-061, TBL-039 |
| EC-48 | Revoked sessions are excluded from DP-067's purge regardless of how long past `expires_at` they are — a `revoked` session dated arbitrarily far in the past is still present after `PurgeExpiredSessions` runs | DP-067, TBL-037 |
| EC-49 | On successful step-up, the access token hash is rotated even though only the assurance tier nominally changed — a pre-step-up access token cannot be replayed afterward, since `SaveSession`'s hash-migration logic removes the old hash from `accessIndex` | DP-061, ADR-014 |

---

## 4. Scenarios: specified for the deployed topology (forward-looking, blocked on infrastructure)

| ID | Scenario | Cites | Blocked on |
|---|---|---|---|
| HP-10 | A full regional outage triggers automated failover — GeoDNS/anycast reroute plus Postgres standby promotion in the synchronously-replicated second region — without losing any cast ballot or `audit_log` entry, within RTO ≤5min / RPO ≤30s for `ballot`/`audit_log`/`governance_role` | NFR-011, ARCH-006 §1–§2, ARCH-008 §4 | Three-region Kubernetes clusters, cross-region Postgres replication, GeoDNS/anycast edge — none exist in this repo; every service runs single-instance today. |
| HP-11 | The platform sustains 100,000 concurrent active citizens with defined p99 latency (`ballot:cast` ≤1s, read-heavy endpoints ≤300–500ms, write endpoints ≤800ms) during a national vote-close surge, via HPA/KEDA/cluster-autoscaler | NFR-009, ARCH-007 §1–§3, ARCH-006 §7, ARCH-008 §2 | Deployed k8s autoscaling infra (HPA/KEDA/cluster-autoscaler wired to real metrics), a load-generation harness capable of 100k+ concurrent, and Kafka/Postgres provisioned at ARCH-007 §4's sizing. |
| EC-50 | Burst headroom to 300,000 concurrent (3x sustained) in the final hour before a national vote-close deadline does not breach the `ballot:cast` p99 ≤1s target | ARCH-007 §3, ARCH-008 §2 | Same as HP-11, plus a synthetic traffic generator shaped to ARCH-007 §3's "final-hour concentration" load profile, not a flat rate. |
| EC-51 | Loss of one region's Kafka cluster does not affect `audit.append` durability (mirrored to the other two regions via MirrorMaker 2); that region's other queues resume from last committed offset once restored, delayed but not lost | ARCH-006 §4, ARCH-008 §4 | Deployed per-region Strimzi Kafka clusters and MirrorMaker 2 replication — no Kafka deployment exists in this repo (ADR-016 is a decision, not yet realized in `infra/`). |
| EC-52 | A platform-operator's database-restore-from-backup action is rejected without a second, independent platform-operator's co-approval, even under an active break-glass grant | AUTH-011, ARCH-008 §4 "Database corruption" runbook | Both the DP-068 business-rule gap in §3.3 (EC-27–EC-30) and a real backup/restore mechanism against deployed Postgres — neither exists today. |
| EC-53 | A canary rollout that burns its SLO error budget faster than the configured fast-burn rate is automatically rolled back before reaching full traffic | ARCH-006 §8, ARCH-008 §2 | Argo CD progressive-delivery pipeline and Prometheus burn-rate alerting wired to a real rollback trigger — not deployed. |
| EC-54 | A quarterly full DR drill fails over live traffic to a secondary region and publishes drill results (time-to-recover vs. RTO/RPO, deviations) to the audit log | NFR-011, ARCH-008 §4 | Drill execution tooling — explicitly out of scope for this document per ARCH-009 §6; this scenario states only the verification target (results published, targets met), not how the drill is triggered. |
| EC-55 | A scheduled chaos exercise (pod kill, network partition, simulated region isolation) run in a staging environment sized to ARCH-007's capacity plan surfaces no gap against the SLOs or RTO/RPO targets | ARCH-007 §6, ARCH-008 §5 | A staging environment at national-scale sizing and chaos-injection tooling — neither exists in this repo. |

---

## 5. Traceability

| Scenario | FR/NFR/AUTH ids | Level | Automated test id | Testable today? |
|---|---|---|---|---|
| HP-1 | DP-059, ADR-014 | Single-service (auth-service) | TBD | Yes |
| HP-2 | DP-060, ADR-014 | Single-service (auth-service) | TBD | Yes |
| HP-3 | DP-061, ADR-014, AUTH-010 | Single-service (auth-service) | TBD | Yes |
| HP-4 | DP-059, ADR-014 | Single-service (auth-service) | TBD | Yes |
| HP-5 | DP-059, ADR-014 | Single-service (auth-service) | TBD | Yes |
| HP-6 | DP-066, ADR-014 | Single-service (auth-service) | TBD | Yes |
| HP-7 | DP-067, TBL-037 | Single-service (auth-service) | TBD | Yes |
| HP-8 | AUTH-011, TBL-032 | Single-service (governance-role-service) | TBD | Yes |
| HP-9 | DP-035, TBL-033 | Single-service (governance-role-service) | TBD | Yes |
| EC-1–EC-3 | DP-059, NFR-007 | Single-service (auth-service) | TBD | Yes |
| EC-4 | SRV-017 | Single-service (auth-service) | TBD | Yes |
| EC-5–EC-11 | DP-060 | Single-service (auth-service) | TBD | Yes |
| EC-12–EC-13 | DP-061, SRV-017 | Single-service (auth-service) | TBD | Yes |
| EC-14–EC-15 | DP-060 | Single-service (auth-service) | TBD | Yes |
| EC-16–EC-17 | DP-061, TBL-037, TBL-038 | Single-service (auth-service) | TBD | Yes |
| EC-18 | DP-059, DP-066 | Single-service (auth-service) | TBD | Yes |
| EC-19 | DP-059 | Single-service (auth-service) | TBD | Yes |
| EC-20 | ADR-014, SRV-017 | Single-service (auth-service) | TBD | Yes |
| EC-21–EC-22 | SRV-017, DP-035 | Single-service (auth-service) | TBD | Yes |
| EC-23–EC-26 | TBL-032, TBL-033, DP-035, ADR-001 | Single-service (governance-role-service) | TBD | Yes |
| EC-27 | AUTH-011, AUTH-006, ADR-001 | Single-service (governance-role-service) | TBD | No — gap, not enforced |
| EC-28 | DP-068, AUTH-011 | Single-service (governance-role-service) | TBD | No — gap, not enforced |
| EC-29 | DP-068, ADR-001, ADR-017 | Single-service (governance-role-service) | TBD | No — cannot be constructed against current endpoints |
| EC-30 | DP-068, AUTH-003 | Single-service (governance-role-service) | TBD | No — gap, not enforced |
| EC-31–EC-32 | DP-066, ADR-014 | Single-service (auth-service) | TBD | Yes |
| EC-33 | ADR-014, DP-059 | Single-service (auth-service) | TBD | Yes |
| EC-34 | DP-067 | Single-service (auth-service) | TBD | Yes |
| EC-35 | DP-060, DP-061 | Single-service (auth-service) | TBD | Yes |
| EC-36 | DP-059 | Single-service (auth-service) | TBD | Yes |
| EC-37 | SRV-017 | Single-service (auth-service) | TBD | Yes |
| EC-38 | DP-066, DP-059 | Single-service (auth-service) | TBD | Yes |
| EC-39 | DP-059 | Single-service (auth-service) | TBD | Yes |
| EC-40 | DP-060 | Single-service (auth-service) | TBD | Yes |
| EC-41 | DP-035 | Single-service (governance-role-service) | TBD | Yes |
| EC-42 | ARCH-009 §2, SRV-017 | Integration (seam not implemented) | TBD | No — no real seam to fail |
| EC-43 | DP-066 | Integration (seam not implemented) | TBD | Partial — auth-service-side state only |
| EC-44 | DP-036, ARCH-009 §2 | Integration (seam not implemented) | TBD | Partial — emission call only, not delivery |
| EC-45–EC-49 | DP-059, DP-061, DP-066, DP-067, ADR-014, TBL-037, TBL-039 | Single-service (auth-service) | TBD | Yes |
| HP-10 | NFR-011, ARCH-006, ARCH-008 | e2e (topology-wide) | TBD | No — blocked on infra |
| HP-11 | NFR-009, ARCH-006, ARCH-007, ARCH-008 | e2e (topology-wide) | TBD | No — blocked on infra |
| EC-50 | ARCH-007, ARCH-008 | e2e (topology-wide) | TBD | No — blocked on infra |
| EC-51 | ARCH-006, ARCH-008 | e2e (topology-wide) | TBD | No — blocked on infra |
| EC-52 | AUTH-011, ARCH-008 | e2e (topology-wide) | TBD | No — blocked on infra + application-logic gap |
| EC-53 | ARCH-006, ARCH-008 | e2e (topology-wide) | TBD | No — blocked on infra |
| EC-54 | NFR-011, ARCH-008 | e2e (topology-wide) | TBD | No — blocked on drill tooling (out of scope, ARCH-009 §6) |
| EC-55 | ARCH-007, ARCH-008 | e2e (topology-wide) | TBD | No — blocked on infra |
