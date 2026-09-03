---
id: ARCH-024
type: arch
title: "iam-service: policy schema, evaluation algorithm, and dual-control change flow"
status: active
created: 2026-09-03
---

## Overview

Concrete design realizing ADR-025. `iam-service` (SRV-018) owns three tables — `access_policy`, `policy_attachment`, `policy_endorsement` — and exposes one evaluation entrypoint plus the propose/endorse/revoke flow every other operator/platform-operator-gated write goes through instead of a hardcoded permission check. Its own database follows ARCH-023's pattern exactly (`iam_app`/`iam_worker` roles, RLS forced everywhere, `current_citizen_id()` helper) — this document covers what's specific to iam-service: the policy shape, the matching algorithm, and why dual control works the way it does here.

## 1. Principals

A principal is referenced by a plain string, `principal_ref`, in one of two shapes — no separate principal table; `governance_role` (governance-role-service) already is the authoritative record of who holds what:

- `citizen:<uuid>` — an individual operator or platform-operator (their `governance_role.citizen_id`).
- `role:operator` / `role:platform_operator` — every citizen currently holding an active governance role of that type, resolved at evaluation time via `GET /governance-roles/roles?role_type=...` (governance-role-service, already-existing endpoint).

Role-wide attachments exist so a permission change that should apply to "every platform-operator" doesn't require re-attaching a policy to each individual as people rotate through the role (ADR-009's randomized/time-limited roles already turn over on a schedule) — see ARCH-023 §5's cross-service-limitation precedent: this table cannot locally verify "is `citizen:<uuid>` currently a platform-operator," so evaluation resolves that over HTTP against governance-role-service's public read endpoint, the same shape as every other cross-service scope check in this codebase.

## 2. Why dual control, not DP-035's three-layer approval

DP-035's `citizen_supermajority` / `audit_confirmation` / `body_endorsement` set (governance-role-service's `services/approvals.ts`) hard-maps each approval type to exactly one `layer` (`citizen`, `audit`, `protocol` respectively) — there is no mapping for the `implementation` layer operator and platform-operator roles occupy (`domain/types.ts`'s `LAYERS`), so that endpoint structurally cannot be satisfied by two operators or two platform-operators no matter how many approvals they submit. Reusing it here would be reusing the wrong tool, not the right seam.

DP-068 (platform break-glass access) already solved this exact shape of problem — a same-role-type, real-time, two-person check — for a different table (`governance_role`/`approval`). iam-service reimplements that same rule locally, against its own tables, rather than bending governance-role-service's three-layer endpoint to fit: **a proposal is activated once a second, distinct citizen holding an active governance role of the same `role_type` as the proposer records an `approved` endorsement.** Both the proposer's and the endorser's role are verified live against governance-role-service's `GET /governance-roles/roles?citizen_id=...` at proposal/endorsement time (fail closed on any lookup failure — the same contract every existing HTTP integration seam in this codebase already uses).

## 3. Tables

- **`access_policy`** — `id, name, effect ('allow'|'deny'), actions text[], resources text[], conditions jsonb NULL, description, status ('pending_approval'|'active'|'rejected'|'revoked'), proposed_by uuid (citizen_id), created_at`. PUBLIC read; `iam_worker`-only write (the propose/endorse/revoke handlers all do their own governance-role-service-backed eligibility checks before writing, the same "cross-service check resolved before the worker-role write" shape ARCH-023 §5 already establishes for `project_milestone`/`outcome_evaluation`/`constitutional_review`).
- **`policy_attachment`** — `id, policy_id -> access_policy, principal_ref text, status ('pending_approval'|'active'|'revoked'), proposed_by uuid, created_at`. Same PUBLIC-read/worker-write shape.
- **`policy_endorsement`** — `id, target_type ('policy'|'attachment'), target_id uuid, endorser_citizen_id uuid, decision ('approved'|'rejected'), created_at`, `UNIQUE (target_type, target_id, endorser_citizen_id)` (one endorsement per citizen per target — mirrors `approval`'s own one-per-citizen-per-action rule). PUBLIC read (transparency of who endorsed what); `iam_worker`-only write.

No cross-database FK to `governance_role.id` (jurisdiction-service-style intentional gap, ADR-015) — `proposed_by`/`endorser_citizen_id` are citizen_ids, verified live over HTTP, not joined.

## 4. Evaluation algorithm (`POST /iam/evaluate`)

Request: `{principal_ref, action, resource, context?}` (a caller passes the concrete `citizen:<uuid>` — role-wide expansion happens inside iam-service, not the caller). Response: `{effect: 'allow'|'deny', matched_policy_id}`.

1. Collect every `active` `policy_attachment` whose `principal_ref` is either the request's `principal_ref` verbatim, or `role:<role_type>` for a role_type the principal currently, actively holds (resolved via governance-role-service).
2. For each attached policy (status `active`), match: `action` matches one entry in `actions` (exact string, or a trailing `*` wildcard prefix — e.g. `secrets:*` matches `secrets:rotate`); `resource` matches one entry in `resources` the same way; if `conditions` is present, every key must match the request's `context`.
3. If any matching policy has `effect: 'deny'` → **deny** (explicit deny always wins, matching AWS IAM's own rule).
4. Else if any matching policy has `effect: 'allow'` → **allow**.
5. Else → **deny** (default deny — an operation with no matching policy is never implicitly permitted, consistent with AUTH-010's own "if an operation is not listed here, it is denied by default").

Only propose/endorse/activate/revoke transitions are audited (`audit.append`) — individual `evaluate` calls are not, to avoid flooding the audit log with read-path traffic; this mirrors every other service's existing distinction between governance-relevant writes (always audited) and reads (not).

## 5. Change flow

**Grant (dual control required):**
1. `POST /iam/policies` or `POST /iam/attachments` — proposer must hold an active `operator` or `platform_operator` role (checked live); row created `status: pending_approval`.
2. `POST /iam/policies/:id/endorsements` or `.../attachments/:id/endorsements` — endorser must be a *different* citizen holding an active role of the *same* `role_type` as the proposer. On the first `approved` endorsement, status flips to `active`. A `rejected` endorsement flips it to `rejected` (either co-reviewer can veto; no override).

**Revoke (unilateral, no dual control — DP-068's asymmetry):**
3. `POST /iam/attachments/:id/revoke` (or `.../policies/:id/revoke`) — any citizen holding an active `operator`, `platform_operator`, or auditor (AUTH-003) role may revoke immediately. Fail-safe direction: pulling back access is always easier than granting it.

## Consequences

Every operator/platform-operator permission change is public, audit-logged, and requires a second independent same-type role holder to take effect — but revocation stays fast and unilateral, so a compromised or over-permissioned grant can always be pulled back quickly even though it could never have been created quickly. No call site in this codebase is wired to call `/iam/evaluate` yet; that wiring (budget-service, project-service, governance-role-service, and any future operator/platform-operator-gated route) is separate follow-on work, same as every other open HTTP integration seam ARCH-010/011/012 already document.
