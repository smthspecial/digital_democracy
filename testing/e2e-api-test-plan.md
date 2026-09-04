# E2E API Test Plan — Digital Democracy Platform

Scope: **API-level only** (no UI/browser). Covers all 18 microservices. Three tiers, in order of execution:

1. **Happy paths** — the golden flows the platform is designed to support.
2. **Edge cases** — boundary conditions, illegal state transitions, validation gaps, race conditions.
3. **Abuse / "criminal user" scenarios** — an adversarial actor deliberately trying to defraud, manipulate, deanonymize, or break the system, run against what the spec *promises* vs. what the code *currently does*.

This plan is grounded in the actual OpenAPI contracts, service source, and `.spec/` architecture/threat docs as of 2026-09-03 — not aspirational behavior. Every abuse scenario is tagged with a **Verdict** telling you whether the current implementation actually defends against it. Treat `VULNERABLE` verdicts as failing tests to file as bugs, not as test-plan errors — they were confirmed by reading the handler code, not assumed.

---

## 0. Environment & Ground Rules

### 0.1 Service directory

| # | Service | Spec ID | Lang | Base path | Port (docker-compose) |
|---|---|---|---|---|---|
| 1 | identity-service | SRV-001 | TS | `/identity` | 4001 |
| 2 | jurisdiction-service | SRV-002 | TS | `/jurisdiction` | 4002 |
| 3 | problem-service | SRV-003 | TS | `/problems` | 4003 |
| 4 | proposal-service | SRV-004 | TS | `/proposals` | 4004 |
| 5 | competency-service | SRV-005 | TS | `/competency` | 4005 |
| 6 | deliberation-service | SRV-006 | TS | `/deliberation` | 4006 |
| 7 | budget-service | SRV-007 | TS | `/budget` | 4007 |
| 8 | voting-service | SRV-008 | Go | `/voting` | 5001 |
| 9 | civic-duty-service | SRV-009 | TS | `/civic-duty` | 4008 |
| 10 | delegation-service | SRV-010 | Go | `/delegation` | 5002 |
| 11 | governance-role-service | SRV-011 | TS | `/governance-roles` | 4009 |
| 12 | audit-service | SRV-012 | Go | `/audit` | 5003 |
| 13 | project-service | SRV-013 | TS | `/` (projects) | 4010 |
| 14 | reputation-service | SRV-014 | TS | `/reputation` | 4011 |
| 15 | notification-service | SRV-015 | TS | `/notifications` | 4012 |
| 16 | ai-synthesis-service | SRV-016 | TS | `/ai-synthesis` | 4013 |
| 17 | auth-service | SRV-017 | Go | `/auth` | 5004 |
| 18 | iam-service | SRV-018 | TS | `/iam` | 4014 |

All expose `GET /healthz` and `GET /readyz`. Bring the stack up via `docker-compose up` (NATS on 4222/8222, Postgres on 5432 — note most services currently run **in-memory only**, DB wiring is partial; state does not survive a restart).

### 0.2 Stale-spec warning (read before writing any test against the OpenAPI files)

Do not codegen clients from these files as-is — they lag the real implementation:

- **proposal-service, governance-role-service, competency-service, civic-duty-service, iam-service**: `openapi.yaml` documents `/healthz`/`/readyz` only (or is entirely absent for iam-service). The real endpoints in this plan were reconstructed from route/service source and are what you should test against.
- **project-service**: `openapi.yaml` has a dangling `components:` section (schemas referenced but never defined) — structurally broken as a contract doc.
- **budget-service**: `LedgerEntry`/`RecordLedgerEntryRequest` schemas omit the real `project_id` field that exists in code.

### 0.3 Implementation-phase caveats that shape every test

These are not bugs to report — they're the current phase's known scope, and tests should be written with them in mind so failures are attributed correctly:

- **No authentication/authorization exists on almost any endpoint, in any of the 18 services.** Every `citizen_id`, `actor_ref`, `recorded_by`, `requesting_citizen_id`, etc. is a self-asserted, unverified string in the request body. This is the single biggest fact governing the abuse section below — most "abuse" scenarios succeed today because there is no identity check to stop them. Where AUTH-009/010 *specifies* a guard that doesn't yet run, this plan calls it out explicitly.
- **Cross-service existence validation is inconsistent.** Some links are checked (proposal→jurisdiction scope), most are not (citizen_id in jurisdiction/competency/budget/project/reputation/civic-duty, problem_id in proposal, proposal_id in ai-synthesis/project).
- **Several gating seams are stubs that default permissive**: `ApprovalGate` (identity suspend/revoke — verify current wiring is fail-closed, this flipped at least once per ARCH-010), `CompetencyChecker` in delegation-service (defaults `true`), `AssignmentChecker.isAssignedReviewer` in proposal-service (defaults `true`), `ConstitutionalReviewer` in proposal-service (`{blocked:false}` always), `SynthesisTrigger`/`ThresholdChecker` in deliberation/problem-service (no-ops).
- **No rate limiting exists anywhere** in any of the 18 services (grep-confirmed, no throttling middleware). No numeric rate-limit values exist anywhere in the `.spec/` docs either — do not assert a specific 429 threshold; assert (and expect to confirm) the *absence* of one, and flag it as a spec gap.
- **No CAPTCHA / bot-detection / proof-of-humanity layer exists anywhere.**
- All services are currently single-process, in-memory (no real DB persistence, no multi-instance consistency) — do not write tests that assume state survives a restart or is shared across instances.

### 0.4 Test data conventions

- Use a fresh UUID-shaped string per synthetic citizen (`citizen_id`) per test case; the platform currently accepts arbitrary strings as citizen IDs almost everywhere, so this is sufficient to isolate test runs — but note that this exact permissiveness is itself the largest abuse surface (§4).
- Where a flow requires a *real, verified* citizen, drive it through identity-service's verification endpoint first, don't fabricate it downstream.
- Reset state between suites by restarting the stack (no delete endpoints exist for most resources — this is by design for audit/ledger/vote data, and a state-pollution risk for problem/proposal/argument data).

---

## 1. HAPPY PATH SCENARIOS

Each scenario lists the services touched, the call sequence, and the expected end state. These are the flows the platform is built to support end-to-end.

### HP-1 — Citizen onboarding → verified identity → authenticated session → MFA step-up

**Services**: identity-service, auth-service

1. `POST /identity/citizens` `{public_handle, raw_legal_identifier}` → 201, `status:"pending"`.
2. `POST /identity/citizens/{id}/verifications` `{evidence_ref, outcome:"verified", method:"national_id"}` → 201; citizen flips to `status:"active"`.
3. `POST /auth/login` `{citizen_id, credential_valid:true, device_fingerprint, ip_subnet}` → 200, `Session{assurance_tier:"T1"}`, `requires_step_up:true`.
4. `POST /auth/factors` `{citizen_id, session_id, factor_type:"totp", ...proof}` → 200, tier bumps to `T2`.
5. `POST /auth/stepup` `{session_id, tier:"T3", factor_type:"passkey", ...proof}` → 200, fresh access token, tier `T3`.

**Expected**: citizen is `active`, session is `active` at `T3`, ready to perform a high-stakes write (ballot cast, approval submit).

### HP-2 — Session refresh lifecycle

**Services**: auth-service

1. Login (as HP-1 steps 1–3).
2. `POST /auth/refresh` `{refresh_token, device_fingerprint, ip_subnet}` (same fingerprint/subnet) → 200, new access+refresh token pair, old refresh token invalidated.
3. Repeat refresh with the *new* token → 200 again (rotation chain continues).

**Expected**: each refresh rotates the token; tier stays T1→ downgrades correctly if `last_mfa_at` > 12h stale (see EDGE-AUTH-3).

### HP-3 — Jurisdiction, residency, and eligibility

**Services**: jurisdiction-service

1. `POST /jurisdiction/jurisdictions` create a `national` root, then a `regional` child (`parent_id`), then a `city` grandchild.
2. `POST /jurisdiction/memberships` `{citizen_id, jurisdiction_id: city}` → 201.
3. `POST /jurisdiction/residencies` `{citizen_id, jurisdiction_id: city, start_date: 45 days ago}` → 201, `verified:true`.
4. `GET /jurisdiction/eligibility?citizen_id&scope_jurisdiction_id=city&min_residency_days=30` → `{eligible:true}`.

**Expected**: membership + residency in the *same* node beyond the minimum period yields eligibility.

### HP-4 — Full civic pipeline: problem → proposal → deliberation → AI synthesis → budget → vote → project → outcome

**Services**: problem, proposal, deliberation, ai-synthesis, budget, voting, delegation, project, jurisdiction, audit — the flagship cross-service journey (ARCH-011/012).

1. `POST /problems` `{citizen_id, title, description, affected_area, candidate_scope}` → 201 `status:"open"`.
2. `POST /problems/{id}/support` from N distinct citizens → `support_count` increments each time.
3. `POST /proposals` `{problem_id, title, description, author_id}` → 201 `status:"draft"`.
4. `POST /proposals/{id}/constraints` → constraint appended.
5. `POST /proposals/{id}/scope-assignment` `{scope_jurisdiction_id, population}` → `support_threshold = ceil(population*0.05)` computed.
6. `POST /proposals/{id}/support` from ≥ `support_threshold` distinct citizens.
7. `POST /proposals/{id}/advance` (`draft→gathering_support→development`) → 200 once threshold met.
8. `PUT /proposals/{id}/budget` `{cost, funding_source, maintenance_cost, expected_benefits}`.
9. Post arguments: `POST /deliberation/arguments` `{proposal_id, citizen_id, content, evidence_ref, stance}` ×5+ to cross the DP-037 synthesis-trigger threshold; post `POST /deliberation/preferences` similarly against the `problem_id`.
10. `POST /ai-synthesis/synthesize` `{proposal_id, arguments:[...], preferences:[...]}` → 200, output carries the mandatory `"AI-generated analysis — advisory only, subject to human review."` label (server-forced, cannot be overridden).
11. `POST /proposals/{id}/advance` (`development→voting`) → requires budget fields set, no pending scope challenge, constitutional review clear.
12. `POST /voting/sessions` (voting-service) `{proposal_id, jurisdiction_id, method:"approval", threshold_rule, min_participation, cooling_off_until: past, opens_at: past, closes_at: future}` → 201 `status:"scheduled"`.
13. `POST /voting/sessions/{id}/options` add ≥2 options.
14. `POST /voting/sessions/{id}/open` `{eligible_citizen_ids:[...]}` → 200, returns one `token_secret` per citizen (capture these — they're bearer secrets, returned exactly once).
15. Per citizen: `POST /voting/ballots` `{session_id, token_secret, choice}` → 201, returns a `verification_code`.
16. `GET /voting/ballots/verify?session_id&code=` → `{found:true}` (self-verification, no choice content revealed).
17. Advance `closes_at` into the past, then `POST /voting/sessions/{id}/close` → 200, synchronous tally + certify chain runs (Shamir 3-of-5 key reconstruction → decrypt → count → quorum check).
18. `GET /voting/sessions/{id}` → `status:"certified"` (if quorum met) with a populated `tally`.
19. `POST /proposals/{id}/resolve` `{outcome:"approved"}` (only legal from `voting`).
20. `POST /` (project-service) `{proposal_id, contractor, budget_allocated, objective, promised_outcome, milestones:[...]}` → 201.
21. `POST /:id/milestones/:milestoneId/complete` for each milestone → last one auto-sets `project.status:"completed"`.
22. `POST /:id/budget-spent` `{amount, description}` → mirrors an outflow into budget-service's `/budget/ledger`.
23. `POST /outcome-evaluations/sweep` `{now: 181 days after completion}` → requests an evaluation.
24. `POST /outcome-evaluations/:id/submit` `{measured_outcome, evaluation:"successful"}` → 200; triggers a +15 reputation credit to the proposal's author (best-effort, via a live call back to proposal-service).

**Expected**: every step succeeds in sequence; `GET /audit/log` shows corresponding entries (`proposal_created`, `vote_certified`, etc.) hash-chained together; `GET /reputation/citizens/{author_id}` shows the +15 credit.

**Known documented gap to account for, not a bug**: problem-level `support` (step 2) and proposal-level `support` (step 6) are two disconnected counters — DP-028's "endorsement crossing triggers a proposal threshold check" is not implemented (`ThresholdChecker` is a no-op). Don't assert cross-linkage between them.

### HP-5 — Liquid democracy delegation, including transitive resolution at vote time

**Services**: delegation-service, voting-service

1. `POST /delegation/delegations` `{delegator_id: A, delegate_id: B, domain_id, expires_at: future}` → 201.
2. `POST /delegation/delegations` `{delegator_id: B, delegate_id: C, domain_id, expires_at: future}` → 201 (transitive chain A→B→C).
3. `POST /delegation/resolve` `{delegate_id: C, domain_id}` → `{delegator_ids:[A,B]}` (both direct and transitive resolve to C).
4. Run a vote session where `domain_id` equals the `proposal_id`; have C cast a ballot → `ballot.weight = 1 + len(delegator_ids)` = 3.
5. `DELETE /delegation/delegations/{id}` (A→B) with `{requesting_citizen_id: A}` → 200, `revoked_at` set; re-run `/delegation/resolve` → only B resolves to C now.

**Expected**: chain resolution, weighting, and revocation all behave per §domain rules. See ABUSE-DELEG-* for the same flow's adversarial variant.

### HP-6 — Multi-approval governance action (identity revoke) across three independent layers

**Services**: governance-role-service, identity-service

1. Create three governance roles with `layer` ∈ {citizen, audit, protocol} for three distinct citizens, `term_end` in the future.
2. `POST /governance-roles/approvals` ×3, one per role, with `approval_type` matching each role's required layer (`citizen_supermajority`↔citizen, `audit_confirmation`↔audit, `body_endorsement`↔protocol) — target the same `action_ref` (e.g. `identity:revoke:{citizenId}`).
3. `GET /governance-roles/actions/{actionRef}/status` → `fully_approved:true`.
4. `POST /identity/citizens/{id}/revoke` → 200 (approval gate satisfied).

**Expected**: revoke only succeeds once all three independent layers have signed off; no single layer suffices (cross-verify with ABUSE-GOV-1/2).

### HP-7 — IAM dual-control policy lifecycle

**Services**: iam-service, governance-role-service

1. Grant citizen X an active `operator` role (governance-role-service).
2. `POST /iam/policies` as X: `{name, effect:"allow", actions:["budget:read"], resources:["*"], proposed_by:X}` → 201 `status:"pending_approval"`.
3. Grant citizen Y a second, independent active `operator` role.
4. `POST /iam/policies/{id}/endorsements` `{endorser_citizen_id:Y, decision:"approved"}` → 200, `status:"active"`.
5. `POST /iam/attachments` `{policy_id, principal_ref:"role:operator", proposed_by:X}` → propose + endorse the same way → `status:"active"`.
6. `POST /iam/evaluate` `{principal_ref:"citizen:X", action:"budget:read", resource:"budget:2026"}` → `{effect:"allow"}` (X holds the `operator` role the attachment targets).

**Expected**: grant requires two independent same-role-type citizens; evaluate resolves role-based attachments live.

### HP-8 — Competency application, expert assessment, and conflict-of-interest disclosure

**Services**: competency-service

1. `POST /competency/domains` `{name, description}`.
2. `POST /competency/applications` `{citizen_id, domain_id}` → `status:"applied"`.
3. `POST /competency/applications/{id}/advance` ×5 (through all pipeline stages) → final stage sets `status:"active"`, `expiresAt: +365d`.
4. `GET /competency/citizens/{citizenId}/domains/{domainId}` → `{active:true}`.
5. `POST /competency/assessments` `{proposal_id, citizen_id, domain_id, content, score}` → 201 (no COI, active competency).
6. `POST /competency/conflicts` `{citizen_id, domain_id, description}` → 201; citizen gets a +5 reputation credit for disclosure and is auto-excluded from that domain's future actions.

### HP-9 — Civic-duty assignment, participation scoring, inactivity recovery

**Services**: civic-duty-service

1. `POST /civic-duty/assignments/generate` `{type:"audit_review", target_ref, candidates:[{citizen_id, sphere_relevant:true, competency_match:true}, ...]}` → 201, one winner picked by weighted random.
2. `POST /civic-duty/assignments/{id}/complete` → `status:"completed"`.
3. `POST /civic-duty/participation/score` `{period, inputs:[{citizen_id, voting_count, review_count, audit_count, quota_target}]}` → `ParticipationRecord[]`.
4. `POST /civic-duty/inactivity/sweep` `{period, inactivity_threshold_score}` with a low-scoring citizen → escalation stage advances by 1; re-run with a recovered score → resets directly to stage 0.

### HP-10 — Reputation record lifecycle

**Services**: reputation-service

1. `POST /reputation/records` `{citizen_id, factor_type:"successful_proposal", delta:+15, source_ref:"outcome-eval:{id}"}` → 201 (positive polarity + positive delta = valid).
2. `GET /reputation/citizens/{id}` → `total` reflects the sum of all records to date.

### HP-11 — Audit log append, chain verification, constitutional review, protocol gate

**Services**: audit-service

1. `POST /audit/log` `{action_type:"proposal_created", actor_ref:"proposal-service", payload:{...}, idempotency_key}` → 201.
2. Repeat with the same `idempotency_key` → 201, returns the *original* entry (dedup, not a new link).
3. `GET /audit/log/verify` → `{valid:true, broken_at:null}`.
4. `POST /audit/rights` `{name:"due_process", description, protected:true}`.
5. `POST /audit/proposals/{id}/constitutional-review` `{change_summary: text that doesn't literally contain "due_process"}` → `{blocked:false}` (see ABUSE-AUDIT-3 for the adversarial variant).
6. `POST /audit/protocol-changes/gate` `{required_approval_types, obtained_approval_types: matching, delay_elapsed:true, publicly_visible:true}` → `{released:true}`.

### HP-12 — Notification dispatch and preference management

**Services**: notification-service

1. `PUT /notifications/preferences/{citizenId}` `{email:true, push:true, in_app:true}`.
2. `POST /notifications/dispatch` `{citizen_id, event_type:"vote_session_closing", channel:"email", payload:{...}}` → 202, `status:"delivered"`.
3. `GET /notifications/citizens/{id}` → in-app entry present (if `channel:"in_app"` was also dispatched).
4. Disable a channel via `PUT /notifications/preferences/{citizenId}` `{email:false}`, dispatch again on `email` → `status:"skipped", attempts:0`.

---

## 2. EDGE CASE TEST MATRIX

Organized per service. Each row is a distinct test case targeting a documented boundary, state-machine rule, or validation gap found in the code.

### 2.1 identity-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-ID-1 | Duplicate legal identity | Register citizen A with `raw_legal_identifier:"X"`; register citizen B with the same value | 409 on B (uniqueness via `legal_identity_hash`) |
| EDGE-ID-2 | Duplicate public handle | Register two citizens with identical `public_handle` | **201/201 — no uniqueness constraint exists.** Confirms handle-squatting is currently possible; not a false test failure. |
| EDGE-ID-3 | Re-suspend a revoked citizen | Revoke, then suspend the same citizen | 409, status stays `revoked` (no downgrade) |
| EDGE-ID-4 | Re-revoke a revoked citizen | Revoke twice | 409 on second call |
| EDGE-ID-5 | Verification before first record | `GET` a freshly-registered (`pending`) citizen, submit a `rejected` verification first, then a `verified` one | Status only flips to `active` on the first `verified` record, regardless of prior rejections |
| EDGE-ID-6 | Suspend/revoke on unknown citizen id | `POST /identity/citizens/{random-uuid}/suspend` | 404 |
| EDGE-ID-7 | Duplicate-scan near-miss handles | Register `"Jane Doe"` and `"jane_doe"`, run `/duplicates/scan` | `signal_matches` misses this pair (only exact normalized-equality is checked) — document as a known heuristic weakness, not a bug in this run |
| EDGE-ID-8 | Session cascade on suspend | Log a citizen in (auth-service), then suspend them (identity-service) | All of that citizen's active sessions in auth-service become unusable shortly after (fire-and-forget `revokeAllSessions` call) — verify actual propagation, not just the 200 on suspend |

### 2.2 auth-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-AUTH-1 | Refresh-token reuse (replay) | Login → refresh (token A→B) → refresh again with **A** (already rotated away) | 401, and the session is force-suspended (`anomaly_reason:"token_reuse"`); subsequent use of B should also now fail |
| EDGE-AUTH-2 | Device/IP mismatch on refresh | Login with fingerprint F1/subnet S1 → refresh with F2/S1 | 401 + anomaly suspend (`new_device`) |
| EDGE-AUTH-3 | T1 downgrade on stale MFA | Reach T2, wait/simulate `last_mfa_at` > 12h, then refresh | New session tier downgrades to T1 |
| EDGE-AUTH-4 | Exactly-5 stepup failures in window | 4 failed `/auth/stepup` attempts within 10 min → still usable; 5th failure | 5th triggers `mfa_brute_force` suspend; confirm 4 does **not** trigger it (off-by-one boundary) |
| EDGE-AUTH-5 | Sliding brute-force window | 3 failures, wait >10 min, 3 more failures | Window slides — old failures don't count toward the new set; no premature suspend |
| EDGE-AUTH-6 | T3 via disallowed factor | `POST /auth/stepup {tier:"T3", factor_type:"totp"}` | 400 — only passkey/facial satisfy T3 |
| EDGE-AUTH-7 | Facial match but no liveness | Enroll/stepup facial with a matching embedding but `liveness:false` | Rejected regardless of embedding match |
| EDGE-AUTH-8 | Logout idempotency | Logout twice on the same session | Second call is a silent 200 no-op, not an error |
| EDGE-AUTH-9 | Spoofed client-supplied status | Login with body `citizen_status:"active"` for a citizen actually `suspended` per identity-service | Ignored — real status resolved server-side via `IdentityChecker`; 401 |
| EDGE-AUTH-10 | IdentityChecker unreachable | Simulate identity-service downtime, then login | Fails **closed** (generic 401), not open |
| EDGE-AUTH-11 | Purge boundary | Session expired exactly at grace-period boundary (`expires_at + 24h`) | Confirm purge cutoff is `<`, not `<=` — test at the exact second |

### 2.3 jurisdiction-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-JUR-1 | Duplicate membership | `POST /jurisdiction/memberships` twice for the same `(citizen_id, jurisdiction_id)` | 409 on second |
| EDGE-JUR-2 | Same citizen, multiple jurisdictions | Membership in neighborhood + city + national simultaneously | All succeed — one membership per *distinct* jurisdiction is allowed |
| EDGE-JUR-3 | Residency end before start | `POST /jurisdiction/residencies {start_date: T, end_date: T-1}` | 400 |
| EDGE-JUR-4 | Membership vs. residency in different branches | Membership in branch A, residency in unrelated branch B, both under the same scope root | `eligibility` returns `eligible:false` — same-node requirement enforced |
| EDGE-JUR-5 | Residency for nonexistent citizen | `POST /jurisdiction/residencies {citizen_id: "never-registered"}` | **201 — no cross-service existence check.** Confirms residency (and thus eligibility) can be recorded for a fabricated identity |
| EDGE-JUR-6 | Scope-level change without approval | `POST /jurisdiction/jurisdictions/{id}/scope-level` when approval gate rejects | 403 |
| EDGE-JUR-7 | Unknown parent on jurisdiction create | `POST /jurisdiction/jurisdictions {parent_id: "unknown"}` | 400 |

### 2.4 problem-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-PRB-1 | Duplicate endorsement | Same `citizen_id` supports the same problem twice | 409 on second |
| EDGE-PRB-2 | Illegal backward transition | `status: closed → open` | 409 |
| EDGE-PRB-3 | Same-state repeat transition | `status: open → open` | 409 (forward-only table has no self-loop) |
| EDGE-PRB-4 | Unknown status enum value | `POST /:id/status {status:"archived"}` (not in enum) | 400 — schema validation fires before the transition/existence check runs |
| EDGE-PRB-5 | Status change on unknown problem | `POST /nonexistent-id/status` | 404 |
| EDGE-PRB-6 | Missing required field | `POST /problems` omitting `affected_area` | 400 |

### 2.5 proposal-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-PRP-1 | Proposal against fabricated problem_id | `POST /proposals {problem_id:"does-not-exist", ...}` | **201 — no existence check.** |
| EDGE-PRP-2 | Advance below support threshold | `gathering_support→development` with `support_count < support_threshold` | 409 |
| EDGE-PRP-3 | Advance to voting missing budget fields | `development→voting` with `funding_source` unset | 409, error names the missing field |
| EDGE-PRP-4 | Advance to voting with pending scope challenge | File a scope challenge, don't resolve, attempt advance | 409 |
| EDGE-PRP-5 | Re-run scope-assignment after support gathered | Assign scope (population→threshold), gather support past threshold, re-run scope-assignment with a much larger `population` | **200 — succeeds with no status gate**, silently raising the threshold after real support was already collected (or lowering it, in the inverse case) |
| EDGE-PRP-6 | Zero-population threshold | `scope-assignment {population:0}` | `support_threshold:0` — the gate becomes trivially satisfied with zero support |
| EDGE-PRP-7 | Resolve from non-voting status | `POST /:id/resolve {outcome:"approved"}` while `status:"draft"` | 409 |
| EDGE-PRP-8 | Archive a terminal proposal | `resolve {outcome:"archived"}` on an already-`approved`/`rejected` proposal | 409 |
| EDGE-PRP-9 | Double deadlock entry | `deadlock/enter` twice | 409 on second |
| EDGE-PRP-10 | Deadlock final_decision without outcome | `deadlock/advance` reaching `final_decision` stage with no `outcome` field | 400 |
| EDGE-PRP-11 | Normal advance while deadlock active | `POST /:id/advance` while `deadlock.active:true` | 409 — deadlock hijacks the normal state machine |
| EDGE-PRP-12 | Constraint on a voting-stage proposal | `POST /:id/constraints` when `status` is `voting`/beyond | 409 |
| EDGE-PRP-13 | Negative cost | `PUT /:id/budget {cost:-100}` | 400 |
| EDGE-PRP-14 | Concurrent scope-assignment race | Fire two concurrent `scope-assignment` calls with different `population` values | Last-write-wins, no version conflict error — document the race, don't expect optimistic locking |

### 2.6 deliberation-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-DLB-1 | Missing evidence_ref | `POST /deliberation/arguments` with empty `evidence_ref` | 400 |
| EDGE-DLB-2 | Reply under a locked branch | Lock an agreement-stance argument, then post a reply targeting a descendant several levels down | 409 — lock propagates down the whole subtree, not just direct children |
| EDGE-DLB-3 | Lock a disagreement-stance argument | `POST /:id/lock` where `stance:"disagreement"` | 400 |
| EDGE-DLB-4 | Reply to unknown parent | `parent_id` doesn't exist | 404 |
| EDGE-DLB-5 | Synthesis-threshold counting is per-subject | Post 5 arguments on proposal P1 and 4 on P2 | Only P1's counter crosses the default threshold (5) — confirm independence |

### 2.7 budget-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-BUD-1 | Allocation percentages don't sum to 100 | `{allocations:[{cat,60},{cat2,30}]}` | 400, error reports actual sum (90) |
| EDGE-BUD-2 | Floating-point tolerance | Percentages summing to `100.0000000001` (within 1e-9) | 200 — accepted |
| EDGE-BUD-3 | Duplicate category in one allocation request | Two entries with the same `category_id` | 400 |
| EDGE-BUD-4 | Unknown category_id in allocation | `category_id` doesn't exist | 400 |
| EDGE-BUD-5 | Resubmission replaces, doesn't add | Submit allocations for period P, submit a different set for the same period | Second submission fully replaces the first (delete-then-insert), not additive — verify old rows are gone via `GET /ledger` or an internal listing |
| EDGE-BUD-6 | Category under nonexistent jurisdiction | `POST /budget/categories {jurisdiction_id:"fake"}` | **201 — no existence check** |
| EDGE-BUD-7 | Negative ledger amount | `POST /budget/ledger {type:"inflow", amount:-500}` | **201 — no sign/positivity validation.** Confirms the public ledger can be corrupted with negative entries |
| EDGE-BUD-8 | Reconcile with arbitrary total_pool | Call `/allocations/aggregate` twice with wildly different `total_pool` values | Both succeed, `allocatedAmount` changes each time — no server-side source of truth for total budget |

### 2.8 voting-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-VOT-1 | Open before cooling_off_until | `POST /voting/sessions/{id}/open` while `now < cooling_off_until` | 409 |
| EDGE-VOT-2 | Open before opens_at | Same, with `now < opens_at` but past cooling-off | 409 |
| EDGE-VOT-3 | Close before closes_at | `POST /voting/sessions/{id}/close` early | 409 |
| EDGE-VOT-4 | Re-issue token to same citizen | Call `/open` twice with overlapping `eligible_citizen_ids` | Idempotent no-op for already-issued citizens, no duplicate token |
| EDGE-VOT-5 | Cast with used token | Cast, then cast again with the same `token_secret` | 409 — token flip + insert is atomic |
| EDGE-VOT-6 | Cast with unknown token | Random `token_secret` | 404 (same generic code as unknown session — verify no information leak distinguishing the two) |
| EDGE-VOT-7 | Cast on a scheduled (not-yet-open) session | | 409 |
| EDGE-VOT-8 | Cast on a closed session | | 409 |
| EDGE-VOT-9 | Add option after session opened | `POST /voting/sessions/{id}/options` once `status != scheduled` | 409 |
| EDGE-VOT-10 | Quorum not met | Issue 10 tokens, cast 1 ballot, `min_participation:0.5`, close | `status` stays `closed`, never reaches `certified`; no `vote_certified` audit event fires |
| EDGE-VOT-11 | Supermajority threshold miss | `threshold_rule:"supermajority"`, winner share 60% (< 2/3) | Winner nulled in the tally result |
| EDGE-VOT-12 | Ranked-choice tie elimination | Construct a 3-option IRV round with a tied last place | Tied candidates eliminated together (not an arbitrary single pick) |
| EDGE-VOT-13 | Verify with wrong code | `GET /voting/ballots/verify?code=wrong` | `{found:false}` (not 404 — session exists, code just doesn't match) |
| EDGE-VOT-14 | Verify on unknown session | `?session_id=fake` | 404 |
| EDGE-VOT-15 | Malformed preference_score payload | Score option string with unparseable `optID:score` pairs | Malformed pairs silently dropped from the average, not rejected — confirm this is truly silent, worth flagging as a UX/robustness gap |

### 2.9 delegation-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-DEL-1 | Direct 2-cycle | A delegates to B, then B attempts to delegate to A (same domain) | 400 `ErrCircularDelegation` |
| EDGE-DEL-2 | Longer n-cycle | A→B→C→attempt C→A (same domain) | 400 (BFS reachability check catches transitive cycles too) |
| EDGE-DEL-3 | Cycle across different domains | A→B in domain X; B→A in domain Y | 201 — allowed (cycle check is domain-scoped) |
| EDGE-DEL-4 | Self-delegation | `delegator_id == delegate_id` | 400 |
| EDGE-DEL-5 | expires_at not in the future | `expires_at: now` (exact) | 400 (`.After(now)` is strict — `now` itself is rejected) |
| EDGE-DEL-6 | Revoke boundary semantics | Revoke a delegation with `revoked_at` in the future vs. in the past, check `activeAt(t)` at various `t` | Only disqualified once `revoked_at <= t`; a "future-scheduled" revoke doesn't disqualify early |
| EDGE-DEL-7 | Expiry exact boundary | Check `activeAt(expires_at)` exactly | Not active — `.After` is strict, boundary itself excluded |
| EDGE-DEL-8 | Double revoke | Revoke the same delegation twice | 409 |
| EDGE-DEL-9 | Revoke unknown id | | 404 |
| EDGE-DEL-10 | Expiry sweep idempotency | Run `/delegation/internal/expire` twice in a row | Second call returns `revoked_count:0` |
| EDGE-DEL-11 | Resolve with no active delegations | `/delegation/resolve` for a delegate with none | `{delegator_ids:[]}`, not an error |

### 2.10 governance-role-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-GOV-1 | Wrong layer for approval_type | Submit `citizen_supermajority` using an `operator` (implementation-layer) role | 403 |
| EDGE-GOV-2 | Duplicate approval, same citizen, different role records | Same citizen holds two roles, submits an approval twice for one `action_ref` under each | 409 on the second (dedup by citizen, not role id) |
| EDGE-GOV-3 | Approval from expired-term role | Submit while term valid; let `term_end` pass; re-check `/actions/{ref}/status` | `fully_approved` flips false — re-validated at read time, not cached from write time |
| EDGE-GOV-4 | COI-blocked approver | Approver has an active conflict-of-interest on the action's subject | 403 |
| EDGE-GOV-5 | Execute before delay elapsed | `/execute {delay_elapsed:false}` even with all 3 approval types satisfied | 409 |
| EDGE-GOV-6 | Execute twice | Execute once, execute again | 200, `already_executed:true` (idempotent, not an error) |
| EDGE-GOV-7 | Rotation sweep re-notification | Run `/rotation/sweep` twice within the 7-day window | Second run does not re-flag an already-flagged role |
| EDGE-GOV-8 | term_end <= term_start | `POST /roles` with an inverted term window | 400 |

### 2.11 competency-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-COMP-1 | Advance a non-applied competency | Advance a `rejected` or `active` competency | 409 |
| EDGE-COMP-2 | Advance past final stage | Call `/advance` a 6th time after reaching `active` | 409 |
| EDGE-COMP-3 | Reject a non-applied competency | | 409 |
| EDGE-COMP-4 | Assessment with COI in domain | Citizen has a declared conflict in the domain, attempts an assessment | 403 |
| EDGE-COMP-5 | Assessment without active competency | | 403 |
| EDGE-COMP-6 | Resolve an already-resolved challenge | | 409 |
| EDGE-COMP-7 | Expiry sweep boundary | Competency `expiresAt` exactly at sweep time | Confirm the boundary comparison (`<` vs `<=`) — pin down actual behavior |
| EDGE-COMP-8 | Challenge upheld → revoke + reputation penalty | Uphold a `false_claim` challenge | Competency → `revoked`; reputation delta **exactly -20** with `factor_type:"misinformation"` |

### 2.12 audit-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-AUD-1 | Idempotency key reuse, different payload | Post with `idempotency_key:"K"`, `payload:{a:1}`; post again with the same key but `payload:{a:2}` | Returns the **original** entry (payload `{a:1}`) — no consistency check on reuse, confirm this surprising behavior explicitly |
| EDGE-AUD-2 | Out-of-order arrival | Submit entry B whose `prev_hash` points at a never-submitted entry A | B never appears in `GET /audit/log` listings or affects `/verify` — sits invisibly buffered, no timeout/eviction; confirm it truly never surfaces within a reasonable wait |
| EDGE-AUD-3 | Chain verify pinpoints tampering | (white-box only, not reachable via HTTP) mutate a stored field mid-chain, run `/verify` | `{valid:false, broken_at: <that entry's id>}` |
| EDGE-AUD-4 | Invalid action_type filter | `GET /audit/log?action_type=not_a_real_type` | 400 |
| EDGE-AUD-5 | action_type spec/impl drift | `POST /audit/log {action_type:"proposal_status_changed", ...}` (present in code enum, absent from openapi.yaml) | 201 — accepted by the real implementation despite not being in the documented enum |
| EDGE-AUD-6 | Constitutional review, right name literally present | `change_summary` contains the protected right's name verbatim | `blocked:true` |

### 2.13 project-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-PROJ-1 | Complete an already-completed milestone | | 409 |
| EDGE-PROJ-2 | Non-positive budget-spent amount | `{amount:0}` or negative | 400 (`exclusiveMinimum:0` enforced here, unlike budget-service's ledger) |
| EDGE-PROJ-3 | Submit outcome-evaluation twice | | 409 |
| EDGE-PROJ-4 | Sweep re-request | Run `/outcome-evaluations/sweep` twice for the same completed+delay-elapsed project | Second run skips it (`evaluationRequestedAt` already set) |
| EDGE-PROJ-5 | Milestones sort order | Create with out-of-order `order_index` values | `GET /:id/milestones` returns them sorted by `order_index`, not insertion order |
| EDGE-PROJ-6 | Overspend | `budget-spent` cumulative amount exceeds `budget_allocated` | **200 — no ceiling check exists.** Confirms the gap explicitly (also see ABUSE-FIN-2) |
| EDGE-PROJ-7 | Fabricated proposal_id at creation | `POST / {proposal_id:"fake", ...}` | **201 — no existence/approval check** |

### 2.14 reputation-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-REP-1 | Positive factor with non-positive delta | `{factor_type:"disclosure", delta:0}` | 400 (strict `delta > 0` required) |
| EDGE-REP-2 | Negative factor with positive delta | `{factor_type:"fraud", delta:+5}` | 400 |
| EDGE-REP-3 | Negative factor, empty source_ref | `{factor_type:"manipulation", delta:-10, source_ref:""}` | 400 — empty string normalizes to null, which fails the required-for-negative check |
| EDGE-REP-4 | Negative factor, whitespace-only source_ref | `{source_ref:"   "}` | Confirm whether trim-then-check catches this too |
| EDGE-REP-5 | Significant-delta notification boundary | `delta:9` then `delta:10` (magnitude) | Notification fires only at `|delta| >= 10`, not at 9 |

### 2.15 civic-duty-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-CD-1 | Generate with zero candidates | `{candidates:[]}` | 400 |
| EDGE-CD-2 | Accept/complete/abandon on non-assigned status | Call `/complete` on an already-`abandoned` assignment | 409 |
| EDGE-CD-3 | Rebalance classification boundary | A candidate with exactly `overload_threshold` open assignments | Confirm which side of the threshold is "overloaded" (`>` vs `>=`) |
| EDGE-CD-4 | Audit-pool excludes already-assigned | Refresh the pool with a candidate who already has an open `audit_review` | That candidate is excluded from the new pick |
| EDGE-CD-5 | Inactivity stage caps at 3 | Sweep a chronically low-scoring citizen 5 times in a row | Stage stops advancing past 3, doesn't go to 4+ |
| EDGE-CD-6 | Inactivity recovery is a hard reset | Citizen at stage 2 recovers (`score >= threshold`) | Resets directly to stage 0, not a gradual step-down to 1 |

### 2.16 notification-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-NOT-1 | Banned key at any nesting depth | `payload:{a:{b:{ballot_choice:"x"}}}` | 400 — recursive scan catches nested occurrences |
| EDGE-NOT-2 | Banned key check precedes preference check | Dispatch a banned-key payload to a citizen who has that channel disabled | Still 400 (not silently skipped) — confirms check ordering |
| EDGE-NOT-3 | Retry on terminal status | `/retry` a `delivered`/`skipped`/`failed` notification | 200, unchanged, silent no-op |
| EDGE-NOT-4 | Retry exhausts attempt cap | Retry a `retrying` notification until `attempts >= 3` | Flips to `failed`; further retries remain no-ops |
| EDGE-NOT-5 | Partial preference update, invalid channel | `PUT /notifications/preferences/{id} {email:true, sms:false}` (`sms` not a real channel) | 400 for the whole request, no partial apply |

### 2.17 iam-service

| ID | Case | Steps | Expected |
|---|---|---|---|
| EDGE-IAM-1 | Propose without eligible role | Citizen with only `auditor` role proposes a policy | 403 |
| EDGE-IAM-2 | Self-endorsement | Proposer endorses their own proposal | 403 |
| EDGE-IAM-3 | Cross-role-type endorsement | `operator`-proposed, `platform_operator`-endorsed | 403 |
| EDGE-IAM-4 | Double endorsement by same citizen | Same endorser calls `/endorsements` twice on one target | 409 |
| EDGE-IAM-5 | Endorse a non-pending target | Endorse an already-`active` or `rejected` policy | 409 |
| EDGE-IAM-6 | **Attachment rejection is not terminal** | Endorse an attachment with `decision:"rejected"`, then a *different* eligible citizen endorses `approved` | **200 — succeeds.** Attachment reaches `active` despite the prior rejection (TBL-041 has no `rejected` status) |
| EDGE-IAM-7 | Same sequence on a policy (contrast case) | Identical reject-then-approve sequence on a **policy**, not an attachment | 409 — policy rejection *is* terminal. Run these two side by side; the asymmetry is the point of the test |
| EDGE-IAM-8 | Revoke by ineligible citizen | Citizen with none of operator/platform_operator/auditor attempts revoke | 403 |
| EDGE-IAM-9 | Revoke an already-revoked/rejected target | | 409 |
| EDGE-IAM-10 | Evaluate: deny beats allow | Attach both an explicit allow and an explicit deny policy matching the same principal/action/resource | `{effect:"deny"}` |
| EDGE-IAM-11 | Evaluate: prefix-match action | Policy `actions:["secrets:*"]`, request `action:"secrets:rotate"` | Matches |
| EDGE-IAM-12 | Evaluate: no match anywhere | | `{effect:"deny", matched_policy_id:null}` — default-deny |
| EDGE-IAM-13 | Evaluate: role revoked after attachment made | Attach to `role:operator`; revoke the citizen's operator role in governance-role-service; evaluate again | Effect flips to deny — role membership is checked live, not cached |
| EDGE-IAM-14 | Attachment to unknown policy_id | | 404 |

---

## 3. ABUSE / "CRIMINAL USER" TEST SUITE

Each scenario is written as: **actor & motive → attack steps (pure API calls) → what the spec says should happen → what the current code actually does → verdict**. Run every scenario and record the actual result — several are confirmed `VULNERABLE` by source inspection; your job is to verify that finding still holds against the running system, not to assume it.

**Verdict key**: `VULNERABLE` = attack currently succeeds, no defense fires. `DEFENDED` = attack is currently blocked as designed. `PARTIAL` = some defense exists but is incomplete/bypassable. `GAP-DOCUMENTED` = the spec itself acknowledges this as unimplemented for this phase.

### 3.1 Identity fraud & sybil attacks

| ID | Scenario | Steps | Spec says | Code does | Verdict |
|---|---|---|---|---|---|
| ABUSE-ID-1 | Sybil ring via handle squatting | Register 20 citizens with the identical `public_handle` "Election Official" | FR-001: duplicate-identity detection | No uniqueness on `public_handle` at all | **VULNERABLE** — impersonation-by-handle |
| ABUSE-ID-2 | Duplicate legal identity, near-miss evasion | Register with `raw_legal_identifier:"John Q Public"`, then again with `"john q public "` (case/whitespace variant) | Uniqueness should catch same-person re-registration | `legal_identity_hash` is computed after `.trim()` only — case is **not** normalized, so this may slip past exact-hash matching depending on exact trim/normalize logic | Test both a whitespace-only variant (should collide, verify) and a case variant (verify whether it collides or not) — record actual behavior |
| ABUSE-ID-3 | Duplicate-scan blind spot | Register citizens with visibly-related but non-identical handles ("Election_Official" vs "ElectionOfficial2") | DP-024/056 detect duplicate signals | Default `DuplicateSignal` only catches exact-normalized-equality | **VULNERABLE** — sweep produces a false negative |
| ABUSE-ID-4 | Fake residency to fabricate eligibility | `POST /jurisdiction/residencies` for a `citizen_id` that was never registered in identity-service, with `start_date` backdated 60 days | Only real, verified citizens should gain jurisdiction eligibility | jurisdiction-service never calls identity-service to check existence; `verified:true` is hardcoded | **VULNERABLE** — an entirely fabricated identity can pass `GET /jurisdiction/eligibility` |
| ABUSE-ID-5 | Unauthorized suspend/revoke without real approval-gate wiring | Call `POST /identity/citizens/{id}/suspend` directly against a deployment where `ApprovalGate` defaults permissive | FR-007: no unilateral suspend/revoke, ever | ARCH-010 flags this as historically fail-open by default (reportedly later fixed — **re-verify against the current build**, don't assume) | Confirm current wiring is fail-**closed** before treating as defended |
| ABUSE-ID-6 | Pepper-reset duplicate-detection bypass | Register with legal id "X" → restart identity-service process → register with legal id "X" again | Same person should be caught as a duplicate regardless of service restarts | `legal_identity_hash` pepper is generated fresh per-process, in-memory only — a restart changes the pepper, so the second registration's hash won't match the first's stored hash | **VULNERABLE** (operationally — depends on deployment restarting the process; note as an architectural finding, not just a test bug) |

### 3.2 Authentication & session attacks

| ID | Scenario | Steps | Spec says | Code does | Verdict |
|---|---|---|---|---|---|
| ABUSE-AUTH-1 | Refresh-token theft & replay | Attacker captures a valid refresh token in transit/logs, waits for the legitimate user to refresh (rotating it), then replays the stolen (now-stale) token | Reuse of a rotated-away token should be caught as anomalous | `errAuthenticationFailed` (401) **and** `suspendForAnomaly(token_reuse)` fires | **DEFENDED** — verify the *legitimate* session is also killed, so the attacker's replay causes a real disruption the user will notice (which is the intended signal) |
| ABUSE-AUTH-2 | Session hijack via stolen access token, different device | Attacker uses a stolen valid access token directly (not the refresh flow) against `/auth/internal/validate` | Access tokens should be short-lived (15 min TTL) to bound this window | Validate endpoint doesn't check device/IP at all — only refresh does | **PARTIAL** — access-token-only theft has no device-binding defense within its TTL window; document as inherent to bearer tokens, confirm TTL is actually ~15 min in practice, not 24h (constants show `defaultSessionTTL=24h` for the *session*, not the access token specifically — clarify and record which TTL actually gates `/validate`) |
| ABUSE-AUTH-3 | MFA brute force at scale | Script 4 failed `/auth/stepup` attempts, wait just past 10 minutes, repeat indefinitely to stay under the sliding-window threshold forever | ≥5 failures/10min should suspend | Correctly triggers at 5; a patient attacker pacing at 4-per-10-min evades the counter entirely since there's no longer-window/global-count tracking or CAPTCHA | **PARTIAL** — the mechanism is real but has no defense against a low-and-slow brute force; flag as a gap (no CAPTCHA/velocity-check layer anywhere per spec) |
| ABUSE-AUTH-4 | Login credential-check bypass | Since `credential_valid` has no real verification implementation anywhere in this phase, send `credential_valid:true` directly | A real credential-issuing/verifying step should gate this | ARCH-010/022 confirm this is currently a trusted client-supplied boolean with no backing verifier | **GAP-DOCUMENTED** — flag explicitly as "log in as anyone who knows a citizen_id" once any real client exists; today it's the literal front door |
| ABUSE-AUTH-5 | Concurrent-session abuse across geographies | Log in twice for the same citizen from two fingerprints/subnets "1000km apart" within a short window | DP-066 defines a `concurrent_geos` anomaly (>500km, <2h) | Confirm this anomaly type is actually wired into auth-service's handlers (the delivered inventory only confirms `new_device`/`token_reuse` are live checks in code — `concurrent_geos` and `new_country` appear only in the DP-066 spec, not confirmed present in `service.go`'s anomaly set) | **Re-verify**: run this exact scenario and record whether any anomaly fires at all — likely `GAP-DOCUMENTED` if unimplemented |

### 3.3 Vote manipulation, coercion, and ballot integrity

| ID | Scenario | Steps | Spec says | Code does | Verdict |
|---|---|---|---|---|---|
| ABUSE-VOTE-1 | Double voting | Cast a ballot, attempt to cast again with the same `token_secret` | One vote per eligible citizen | `token.Used` flip + insert atomic under one lock | **DEFENDED** |
| ABUSE-VOTE-2 | Vote selling / coercion via token handoff | Citizen sells/is coerced into handing their `token_secret` (returned once, in plaintext, at `/open`) to a vote buyer, who casts on their behalf | NFR-001/003: coercion resistance | The scheme prevents anyone (including the platform) from later proving *what* was cast, but there is **no secondary factor binding token_secret to the legitimate citizen at cast time** — whoever holds the secret can cast | **VULNERABLE (by design of this phase)** — receipt-freeness is real, but possession-based cast has no anti-coercion binding; flag as the platform's most fundamental unresolved e-voting tension, not a simple bug |
| ABUSE-VOTE-3 | Ballot stuffing via `/open`'s caller-supplied eligible list | Call `POST /voting/sessions/{id}/open {eligible_citizen_ids: [...100 fabricated ids...]}` | DP-025: eligibility should be read from jurisdiction-service, independently verified | Code takes the array directly from the request body with **zero cross-check** against jurisdiction-service | **VULNERABLE** — confirmed top-priority finding; whoever can call `/open` controls the electorate outright |
| ABUSE-VOTE-4 | Disenfranchisement via `/open` omission | Same endpoint, omit specific legitimate citizen IDs from the list | All eligible citizens should receive a token | Same root cause as ABUSE-VOTE-3 — omission is just as easy as injection | **VULNERABLE** |
| ABUSE-VOTE-5 | Constitutional-review bypass at session creation | Create a vote session on a proposal that should have been blocked by constitutional review | DP-034: constitutional review must clear before a session can be scheduled | `CreateSession` never calls audit-service at all | **VULNERABLE (unenforced)** |
| ABUSE-VOTE-6 | Verification-code coercion (participation proof) | Coerce a citizen into revealing their `verification_code` and check `GET /voting/ballots/verify` in front of them, to confirm they in fact voted (even without revealing choice) | Full coercion resistance | `{found:true/false}` proves *participation*, not *choice* — content stays hidden, but presence doesn't | **PARTIAL** — document as an inherent minor residual coercion vector (proof-of-participation), distinct from proof-of-choice which is genuinely defended |
| ABUSE-VOTE-7 | Tally tie-break manipulation | If an attacker can influence option-ID generation order (e.g., via proposal-service's ID scheme) ahead of a predictable tie | Ties should be broken fairly/unpredictably | Every tally method breaks ties **lexicographically by option ID**, deterministic and public | **PARTIAL** — not directly exploitable through voting-service's own API alone, but worth a chained test: create options in an order designed to win ties, confirm the deterministic outcome |
| ABUSE-VOTE-8 | Insufficient-shares tally corruption | (White-box/chaos scenario, not reachable via public API today since shares are internal-only) simulate partial key-share loss/corruption before close | Should fail loudly if the key can't be reliably reconstructed | `shamirCombine` with wrong/insufficient shares **silently returns the wrong plaintext**, no error | **GAP-DOCUMENTED** — flag for when/if share custody becomes externally accessible |
| ABUSE-VOTE-9 | Delegation-inflated ballot weight abuse | Build a wide/deep delegation tree (50+ delegators, several hops) into one delegate, cast one ballot | Delegated weight should reflect only genuine, verified delegation relationships | Chain has no depth cap, resolves purely by graph walk, delegators need not be verified real citizens (see ABUSE-ID) | **VULNERABLE (compounds with ABUSE-ID)** — a sybil ring of fabricated citizens delegating to one attacker-controlled account inflates a single ballot's weight arbitrarily |

### 3.4 Governance & protocol capture

| ID | Scenario | Steps | Spec says | Code does | Verdict |
|---|---|---|---|---|---|
| ABUSE-GOV-1 | Forge a governance approval with no session/authentication | `POST /governance-roles/approvals` directly, knowing only a valid `approver_role_id` (which is publicly listable via `GET /governance-roles/roles`) | Approvals should require an authenticated, MFA-stepped-up session (T3, per AUTH-010) tied to the role holder | No session/MFA check exists in governance-role-service's approval handler at all | **VULNERABLE** — the single most consequential finding in this domain: anyone who can enumerate role IDs can submit approvals as if they were that role holder |
| ABUSE-GOV-2 | Fake protocol-change execution | `POST /governance-roles/actions/{ref}/execute {delay_elapsed:true, publicly_visible:true}` without any real delay having elapsed | These should be server-derived facts, not caller claims | Both are trusted, caller-supplied booleans | **VULNERABLE** |
| ABUSE-GOV-3 | Same attack against audit-service's independent gate | `POST /audit/protocol-changes/gate {delay_elapsed:true, publicly_visible:true, obtained_approval_types: [fabricated matching list]}` | Independent verification against a real approvals store | Pure computation over caller-supplied booleans/arrays, no cross-check to governance-role-service's actual stored approvals | **VULNERABLE** — two independently-callable endpoints (GOV and AUD) both trust the same class of unverified claim; a real attacker would only need to win either one |
| ABUSE-GOV-4 | Self-appointed reviewer bypass | Call `POST /proposals/{id}/deadlock/advance` claiming to be `reviewer_id` for a proposal never actually assigned to you | Only the genuinely assigned reviewer should be able to advance deadlock stages | `AssignmentChecker.isAssignedReviewer` defaults to always-true | **VULNERABLE** |
| ABUSE-GOV-5 | Scope-challenge self-resolution | File a scope challenge against a competing proposal, then immediately resolve it yourself in your own favor | Should require an independent resolver | No actor/role check on the resolve endpoint at all | **VULNERABLE** |
| ABUSE-GOV-6 | IAM policy grant without genuine second approver | Attempt to endorse your own policy proposal, or have a sockpuppet with a fabricated role endorse it | Dual control from a second, independent, same-role-type citizen | Self-endorsement blocked (403); role-type mismatch blocked (403); role membership is live-checked against governance-role-service (not spoofable via a fake role string alone) | **DEFENDED**, contingent on ABUSE-GOV-1 being fixed — if governance-role-service's approval/role-grant path is itself forgeable, this control can be undermined upstream. Test both in isolation and chained |

### 3.5 Financial / budget fraud

| ID | Scenario | Steps | Spec says | Code does | Verdict |
|---|---|---|---|---|---|
| ABUSE-FIN-1 | Fabricated ledger entries | `POST /budget/ledger {type:"inflow", amount:1000000, recorded_by:"any-string-i-like"}` | Only operators should record ledger entries (FR-036) | No caller-identity check, `recorded_by` is free text | **VULNERABLE** — a fabricated, publicly-visible financial record with an impersonated attribution |
| ABUSE-FIN-2 | Negative-amount ledger corruption | `POST /budget/ledger {type:"outflow", amount:-50000}` | Amounts should be positive; sign is implied by `type` | No sign/positivity validation anywhere | **VULNERABLE** — directly corrupts reconciliation math |
| ABUSE-FIN-3 | Project overspend / budget drain | Repeated `POST /:id/budget-spent` calls on a project well past its `budget_allocated` | Spend should be capped at allocation | No ceiling check in `recordBudgetSpent` | **VULNERABLE** |
| ABUSE-FIN-4 | Double-recording via retry (no idempotency) | Retry a `budget-spent` call after a timeout (client can't tell if the first succeeded) | Idempotent recording | No idempotency key support on this endpoint | **VULNERABLE** — a network hiccup or deliberate retry-flood doubles/triples recorded spend |
| ABUSE-FIN-5 | Unauthorized budget-field tampering on someone else's proposal | `PUT /proposals/{id}/budget` as a citizen who is not `author_id` | Only the author should set funding fields | No author check on this write | **VULNERABLE** |
| ABUSE-FIN-6 | total_pool manipulation at aggregation | Call `/budget/allocations/aggregate {total_pool: <inflated number>}` | Total pool should come from an authoritative source | Caller-supplied on every call | **VULNERABLE** — inflates every category's `allocatedAmount` in one request |
| ABUSE-FIN-7 | Fake project against an unapproved/fabricated proposal | `POST /` (project-service) with a `proposal_id` that was never approved, or doesn't exist | Projects should only instantiate from approved proposals | No existence/approval check | **VULNERABLE** |
| ABUSE-FIN-8 | Self-serving outcome evaluation | Guess/enumerate an evaluation id, `POST /outcome-evaluations/:id/submit {evaluation:"successful"}` | Should require the legitimate audit/oversight assignee | No authorization check; civic-duty assignment integration is a no-op stub | **VULNERABLE** — directly triggers a +15 reputation credit to an arbitrary author with zero legitimacy check |

### 3.6 Reputation gaming

| ID | Scenario | Steps | Spec says | Code does | Verdict |
|---|---|---|---|---|---|
| ABUSE-REP-1 | Direct self-boosting | `POST /reputation/records {citizen_id: self, factor_type:"successful_proposal", delta:+1000000, source_ref:"anything"}` repeated | DP-038: reputation changes should only originate from authorized upstream services following a real event | No caller-authentication on this endpoint at all; `source_ref` only checked for non-emptiness, not authenticity | **VULNERABLE** — the single largest reputation-integrity finding; unbounded, unverified, directly callable |
| ABUSE-REP-2 | Rival defamation | `POST /reputation/records {citizen_id: rival, factor_type:"fraud", delta:-1000, source_ref:"fabricated"}` | Negative deltas require "an upstream authoritative decision" (srv-014.md) | Same as above — only sign/non-empty-string checks exist | **VULNERABLE** |
| ABUSE-REP-3 | Sockpuppet ring cross-crediting | Spin up N fabricated citizen_ids, have each submit `successful_proposal`/`constructive` deltas for the others | No identity verification on `citizen_id` here or upstream at registration | Compounds with ABUSE-ID | **VULNERABLE** |
| ABUSE-REP-4 | Replay of a legitimate event | Capture a real, legitimate reputation-record request (e.g., from a genuine outcome evaluation) and resubmit it | Idempotency should prevent double-counting a single real event | No idempotency key on this endpoint | **VULNERABLE** |

### 3.7 Deliberation & content abuse

| ID | Scenario | Steps | Spec says | Code does | Verdict |
|---|---|---|---|---|---|
| ABUSE-DLB-1 | Sybil endorsement to fake consensus | Fabricate N `citizen_id`s, endorse the same problem with each | Endorsements should reflect real, unique citizens | No identity verification, dedup only by client-supplied id string | **VULNERABLE** |
| ABUSE-DLB-2 | Fabricated evidence | Post arguments with `evidence_ref:"trust me"` or a dead URL | FR-028: arguments must reference evidence | Only non-emptiness is validated, no resolution/liveness check | **VULNERABLE** |
| ABUSE-DLB-3 | Astroturfed preference volume forcing skewed AI synthesis | Post many near-identical preferences under fabricated citizen_ids for one problem, enough to cross the DP-037 volume threshold and dominate `shared_objectives` | Synthesis inputs should reflect genuine, diverse participation | Volume-only trigger, exact-normalized-text grouping, no citizen-uniqueness weighting | **VULNERABLE** |
| ABUSE-DLB-4 | AI-synthesis content injection under a real proposal_id | Call `POST /ai-synthesis/synthesize` directly with fabricated arguments/preferences (never posted to deliberation-service) against a real `proposal_id` | Synthesis should reflect actual deliberation-service content (srv-016.md's stated design) | `synthesize` takes arguments/preferences directly as request-body input; no live read-back from deliberation-service exists in this phase | **VULNERABLE** — produces an official-looking, server-labeled "AI-generated analysis" from entirely fabricated content; this is the most serious misinformation/legitimacy-spoofing finding in the platform |
| ABUSE-DLB-5 | Unauthorized branch locking (censorship) | `POST /deliberation/arguments/:id/lock` on an inconvenient agreement-stance argument that isn't yours | Locking should require appropriate authority | No authorization check on who may lock; no unlock path exists at all | **VULNERABLE** — permanent, irreversible via API |
| ABUSE-DLB-6 | Global AI-synthesis kill switch | `POST /ai-synthesis/toggle {enabled:false}` | A protocol-layer decision requiring appropriate authority | Unauthenticated | **VULNERABLE** |
| ABUSE-DLB-7 | Flag-spam on synthesis outputs | Repeat `POST /outputs/:id/flag` unboundedly with the same or fabricated citizen_ids | Flags should be deduplicated/rate-limited | No dedup, no cap on `flag_reasons` growth | **VULNERABLE** |
| ABUSE-DLB-8 | Flooding / spam submission | Loop `POST /problems`, `POST /proposals`, `POST /deliberation/arguments`, `POST /deliberation/preferences` at high volume from one actor | Some reasonable per-actor cap should exist | No rate limiting anywhere in the platform (confirmed, all 18 services) | **VULNERABLE / GAP-DOCUMENTED** — record actual achievable throughput as a baseline, since there is genuinely no code-level limit to test against |

### 3.8 Audit-trail forgery & integrity attacks

| ID | Scenario | Steps | Spec says | Code does | Verdict |
|---|---|---|---|---|---|
| ABUSE-AUDIT-1 | Forged actor_ref | `POST /audit/log {action_type:"vote_certified", actor_ref:"voting-service", payload:{fabricated}}` from an arbitrary caller, not the real voting-service | The audit trail should reflect true system events from authenticated services | No caller authentication; `actor_ref` is a self-declared string; the hash chain proves **sequence** integrity, not **authorship** | **VULNERABLE** — a forged entry passes `/verify` as fully valid, since the chain math never asserted authenticity in the first place |
| ABUSE-AUDIT-2 | Ballot-content leakage into the public log | Submit a `payload` on any audit event that includes actual ballot-choice content | NFR-001: ballot content must never be logged | Enforced entirely by caller discipline; audit-service performs no payload content filtering itself | **VULNERABLE (structural)** — confirms this is enforced by convention, not by the service, exactly as ARCH-021 flags |
| ABUSE-AUDIT-3 | Constitutional-review evasion by rephrasing | Register a protected right named e.g. `"due_process"`; submit a `change_summary` that clearly violates it in substance but never uses that literal string (use a synonym or paraphrase) | DP-034 should catch substantive violations | `keywordMatchAssessor` is a literal case-insensitive substring match on the right's name only | **VULNERABLE** — trivially evaded by rewording |
| ABUSE-AUDIT-4 | Chain starvation via dangling prev_hash | Submit an entry whose `prev_hash` deliberately points at a hash that will never be submitted | Should either error immediately or eventually surface/expire | Buffered indefinitely with no timeout/eviction — silently invisible forever | **GAP-DOCUMENTED** — a resource-exhaustion angle worth a follow-up load test (submit many dangling entries, monitor memory growth) |

### 3.9 Civic-duty assignment gaming

| ID | Scenario | Steps | Spec says | Code does | Verdict |
|---|---|---|---|---|---|
| ABUSE-CD-1 | Rigged candidate weighting | `POST /assignments/generate` with a caller-crafted `candidates` array where your own id has `sphere_relevant:true, competency_match:true` and everyone else has both `false` | Candidate truthfulness should be cross-verified (real sphere/competency data) | Entirely caller-asserted, no cross-service verification | **VULNERABLE** — directly biases the weighted-random selection in the caller's favor |
| ABUSE-CD-2 | Self-nomination to a randomized oversight role | Submit yourself as the sole/dominant candidate for an `audit_review` assignment | AUTH-009: citizens cannot self-assign to randomized roles | No check preventing a caller from constructing a single-candidate (or self-favoring) request | **VULNERABLE** |
| ABUSE-CD-3 | Inactive/suspended citizen still eligible for assignment | A citizen at inactivity stage 3 (should be suspended from advanced participation per FR-054) is submitted as a candidate | Should be excluded | `assignments/generate` never checks `inactivityStage`/`exemptionStatus` at all | **VULNERABLE — contradicts a stated mitigation directly** |
| ABUSE-CD-4 | Assignment-generation flooding to game relative weight | Repeatedly call `/assignments/generate` targeting the same candidate pool to manipulate the workload divisor in the weighting formula | Should be bounded | No rate limit; only a *relative* self-correcting effect via the `1/(1+open_count)` term, no hard block | **PARTIAL** |

### 3.10 Notification abuse (spam, phishing, suppression)

| ID | Scenario | Steps | Spec says | Code does | Verdict |
|---|---|---|---|---|---|
| ABUSE-NOT-1 | Phishing-content injection | `POST /notifications/dispatch {citizen_id: victim, event_type:"vote_session_closing", channel:"email", payload:{body:"Click here to verify your vote: <attacker link>"}}` | Notifications should only originate from real platform events, from authenticated services | No caller authentication; `event_type` is an unconstrained free string; `payload` is unvalidated except for the 5 banned keys | **VULNERABLE** — a highly plausible phishing vector since it can impersonate any legitimate event type |
| ABUSE-NOT-2 | Targeted suppression (disenfranchisement) | `PUT /notifications/preferences/{victimCitizenId} {email:false, push:false}` right before a vote-closing reminder would fire, without the victim's knowledge or consent | Preference changes should only be settable by the owning citizen | No authorization check — any caller can silently mute any other citizen's channels | **VULNERABLE** |
| ABUSE-NOT-3 | Notification-spam harassment | Loop `/dispatch` against one citizen across all three channels with distinct `event_type` values | Reasonable per-citizen throttling should exist | No rate limiting | **VULNERABLE** |
| ABUSE-NOT-4 | Reading another citizen's full inbox | `GET /notifications/citizens/{anyId}` | Should require the requester to be that citizen (or authorized staff) | No authorization check | **VULNERABLE** — privacy/IDOR |

### 3.11 Competency & credential fraud

| ID | Scenario | Steps | Spec says | Code does | Verdict |
|---|---|---|---|---|---|
| ABUSE-COMP-1 | Self-advance to expert status with no real review | Loop `POST /applications/{id}/advance` 5 times with no supporting evidence submitted at any stage | Each stage (automated credential check, public review, domain review, recorded approval) should require real, distinct evidence/action | Pure counter increment, zero content/authorization requirement per stage | **VULNERABLE** — reaches genuine `active` expert status, unlocking assessment-publishing rights, purely by calling one endpoint 5 times |
| ABUSE-COMP-2 | Self-resolve your own competency challenge | File a challenge against your own competency (or have a sockpuppet do it), then resolve it `dismissed` yourself | Should require an independent `review_body` role holder | No reviewer-role check at the service layer at all | **VULNERABLE** |
| ABUSE-COMP-3 | Opposing-party challenge harassment | Submit repeated `credentials`/`misconduct` challenges against a rival expert with no evidence-quality bar beyond a non-empty `evidence_ref` string | Some plausibility/evidence-quality bar implied by FR-022-adjacent intent | `evidence_ref` is unvalidated free text, same weakness as deliberation-service's | **VULNERABLE** |
| ABUSE-COMP-4 | Fabricated citizen_id applies for competency | `POST /applications {citizen_id:"never-registered"}` | Should require a real, verified identity | No cross-check against identity-service | **VULNERABLE** |

### 3.12 Cross-cutting IDOR sweep

Every `{id}`/`{citizenId}`/`{proposalId}` path parameter across all 18 services should be probed for authorization. Given the systemic finding that **no service checks caller identity against the resource being accessed or mutated**, this is best run as a single sweep rather than 18 duplicated scenarios:

| ID | Scenario | Method |
|---|---|---|
| ABUSE-IDOR-1 | Read any citizen's full notification inbox | `GET /notifications/citizens/{id}` for an id you don't control |
| ABUSE-IDOR-2 | Read any citizen's full delegation history | `GET /delegation/delegations?delegator_id={id}` — by design public (FR-056), confirm this is an accepted transparency trade-off, not a bug, but note the deanonymization potential explicitly |
| ABUSE-IDOR-3 | Mutate another citizen's proposal budget fields | Covered in ABUSE-FIN-5 |
| ABUSE-IDOR-4 | Revoke another citizen's delegation via spoofed `requesting_citizen_id` | `DELETE /delegation/delegations/{id} {requesting_citizen_id: <the real delegator's id, which you read off the public GET /delegation/delegations listing>}` | **VULNERABLE** — self-asserted, unauthenticated ownership check; combine reading the public list with the revoke call for a complete PoC |
| ABUSE-IDOR-5 | Read any citizen's reputation ledger | `GET /reputation/citizens/{id}/records` — by design public per spec; confirm this is intended, not accidental |
| ABUSE-IDOR-6 | Silently mute another citizen's notifications | Covered in ABUSE-NOT-2 |

For each, record: is this exposure **intentional transparency** (per FR-056 / public-ledger design intent) or an **unintended authorization gap**? The plan above marks the ledger/delegation-list reads as intentional and the mutation endpoints as gaps — verify this framing holds, since transparency-by-design and missing-authorization can look identical at the HTTP layer.

### 3.13 Denial-of-service / flooding baseline

Since no rate limiting exists anywhere, these aren't pass/fail tests so much as baseline-establishing load tests — run them to produce a number, not a verdict:

| ID | Target | Method |
|---|---|---|
| ABUSE-DOS-1 | problem-service | Sustained `POST /problems` loop, measure achievable req/s and any degradation point |
| ABUSE-DOS-2 | deliberation-service | Sustained `POST /deliberation/arguments` loop against one proposal_id |
| ABUSE-DOS-3 | notification-service | Sustained `/dispatch` loop against one citizen_id |
| ABUSE-DOS-4 | audit-service | Sustained `POST /audit/log` with dangling `prev_hash` values (memory-growth angle, see ABUSE-AUDIT-4) |
| ABUSE-DOS-5 | voting-service | Sustained `GET /voting/ballots/verify` polling with random codes (cheap read, but unthrottled at volume during a real vote window) |

---

## 4. Priority summary — top findings to close before this system could be trusted in production

Ordered by blast radius, not by section:

1. **No authentication/authorization on any of the 18 services.** Every other finding in §3 is a symptom of this one root cause. This is the single highest-priority item.
2. **`voting-service`'s `/voting/sessions/{id}/open` trusts a caller-supplied elector list with zero independent eligibility verification** (ABUSE-VOTE-3/4) — whoever can call this endpoint controls the outcome of every election outright.
3. **`governance-role-service`'s approval endpoints have no session/MFA enforcement** (ABUSE-GOV-1) — the entire multi-approval anti-capture design (ADR-001/009/011) is only as strong as this one unauthenticated endpoint.
4. **`reputation-service` and `audit-service` accept direct, unauthenticated writes** (ABUSE-REP-1/2, ABUSE-AUDIT-1) — both are meant to be authoritative, tamper-evident records; today anyone can write to either directly.
5. **Financial integrity gaps in budget/project services** (ABUSE-FIN-1 through 8) — fabricated ledger entries, unbounded overspend, no idempotency.
6. **AI-synthesis content injection under a real proposal_id** (ABUSE-DLB-4) — produces server-labeled "official" analysis from fabricated input, a misinformation-legitimacy risk distinct from the others because of the trust the AI label itself confers.
7. **Constitutional-review and protocol-gate logic is trust-the-caller** (ABUSE-GOV-2/3, ABUSE-AUDIT-3) — the checks that are supposed to prevent rushed/rights-violating protocol changes are currently either keyword-based or fully client-asserted.
8. **Sybil resistance is weak at every layer that depends on `citizen_id` uniqueness** (ABUSE-ID-1/3, and the sybil-dependent scenarios in §3.3/3.6/3.7) — no service other than identity-service's exact-hash check does any real dedup, and even that has a documented pepper-reset weakness.

Everything else in §3 (notification suppression/phishing, IDOR reads, competency self-advancement, civic-duty rigging) is a real, confirmed finding but of narrower individual blast radius — still worth fixing, but items 1–8 above are what should block a go-live decision.

---

## 5. Suggested execution order

1. Run all of §1 (happy paths) first, against a freshly-started stack, to establish that the golden path works at all and to generate baseline fixture data (citizen IDs, proposal IDs, etc.) for later suites.
2. Run §2 (edge cases) per service, in any order — they're independent of each other.
3. Run §3 (abuse) **last**, and expect a large number of `VULNERABLE` verdicts on a first pass — that is the expected, correct outcome of testing a system at this implementation phase, not a sign the test plan is wrong. File each confirmed `VULNERABLE`/`PARTIAL` result as a tracked security finding referencing this document's ID (e.g. `ABUSE-VOTE-3`) rather than re-describing it from scratch.
4. Re-run §3 after any fix lands, flipping verdicts from `VULNERABLE` to `DEFENDED` over time — this document is meant to be a living regression suite for exactly that purpose.
