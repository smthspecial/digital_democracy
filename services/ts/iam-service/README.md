# iam-service

TypeScript (ADR-019). Owns flexible, policy-based access control for
operator (AUTH-006) and platform-operator (AUTH-011) permissions -- an
AWS-IAM-shaped policy model (ADR-025, ARCH-024) with a dual-control
grant flow and a single evaluation entrypoint other services call instead
of hardcoding a permission check. Spec:
[`.spec/technical/services/srv-018.md`](../../../.spec/technical/services/srv-018.md).
Route prefix `/iam` behind the gateway (ARCH-006). Runs on port 8080
in-container / 4014 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/iam-service dev    # local dev server (tsx watch)
pnpm --filter @dd/iam-service test   # vitest
```

Implements, in-memory (no database yet -- migration is in place at
`db/migrations/0001_init.{up,down}.sql`, not yet wired to a real Postgres
connection):

- `POST /iam/policies` / `GET /iam/policies` -- propose an `access_policy`
  (TBL-040, DP-069) and list policies, optionally filtered by `status`.
  Proposing verifies the proposer holds an active `operator` or
  `platform_operator` governance role (live check, never trusted from the
  request body) and pins whichever qualifying role_type is found onto the
  row (`proposer_role_type`) so endorsement eligibility has an unambiguous
  role_type to match against later. Created `pending_approval`.
- `POST /iam/policies/:id/endorsements` -- dual-control endorsement
  (TBL-042, DP-070): the endorser must be a citizen distinct from the
  proposer, holding an active governance role of the *same* role_type the
  proposer was verified against at propose time (live check) -- modeled on
  DP-068's break-glass co-approval, not DP-035's three-layer approval
  (ARCH-024 §2). An `approved` decision activates the policy; `rejected`
  rejects it. One endorsement per citizen per target.
- `POST /iam/policies/:id/revoke` -- unilateral revoke (DP-072): any
  citizen holding an active `operator`, `platform_operator`, or `auditor`
  (AUTH-003) role may revoke immediately, no dual control -- DP-068's
  grant/revoke asymmetry.
- `POST /iam/attachments` / `GET /iam/attachments` -- propose a
  `policy_attachment` (TBL-041, DP-069) attaching a policy to a
  `principal_ref` (`citizen:<uuid>` or `role:operator` /
  `role:platform_operator`) and list attachments, optionally filtered by
  `principal_ref`. Same proposer-eligibility rule as policies.
- `POST /iam/attachments/:id/endorsements` -- same dual-control rule as
  policy endorsement. One documented deviation: TBL-041's `status` enum
  has no `rejected` value, so a `rejected` decision is still recorded (and
  audited) but leaves the attachment at `pending_approval` rather than a
  status the table spec doesn't define -- flagged in
  `db/migrations/0001_init.up.sql` and `src/services/attachments.ts` for
  spec follow-up.
- `POST /iam/attachments/:id/revoke` -- same unilateral-revoke rule as
  policy revoke.
- `POST /iam/evaluate` -- the read-only evaluation entrypoint (DP-071,
  ARCH-024 §4): given `{principal_ref, action, resource, context?}`,
  collects every `active` attachment applying to the principal (expanding
  `role:*` attachments against currently-active role holders, live), matches
  each attached `active` policy's `actions`/`resources` (exact string or a
  trailing `*` prefix) and `conditions` (every key must match `context`)
  against the request, and returns `{effect, matched_policy_id}`.
  Default-deny, explicit-deny-overrides-allow -- AWS IAM's own algorithm.
  Deliberately **not** audited (read-path traffic, not a governance-relevant
  write, unlike every propose/endorse/revoke transition above).

Every policy, attachment, and endorsement is publicly readable (no hidden
or exclusive grants, CON-005) -- there is no owner-scoped read anywhere in
this service.

## Integrations

Cross-service dependencies are modeled as small injectable interfaces in
`src/collaborators.ts`, each with a permissive/no-op default so the service
runs standalone in tests and local dev, and a real implementation wired in
by `index.ts` when the corresponding env var is set:

- **`GovernanceRoleChecker`** -- the one live dependency ARCH-024 §2
  requires: every propose/endorse/revoke handler verifies the acting
  citizen's claimed role_type against governance-role-service, live, never
  trusted from the request body. `defaultGovernanceRoleChecker` always
  returns `true` (permissive, so the service is usable standalone).
  `createHttpGovernanceRoleChecker`, wired in whenever
  `GOVERNANCE_ROLE_SERVICE_URL` is set, calls governance-role-service's real
  `GET /governance-roles/roles?citizen_id=...&role_type=...` and checks the
  returned rows for one whose term currently covers `now()` (mirroring
  governance-role-service's own `isRoleActive` helper). Fails closed: an
  unreachable governance-role-service or a non-2xx response is treated as
  "no active role", never as "role confirmed" -- the same fail-closed
  contract every other HTTP seam in this codebase uses
  (`createHttpCOIChecker`, `createHttpJurisdictionClient`).
- **`AuditEmitter`** -- mirrors governance-role-service's own
  `audit.append` seam (ADR-023) exactly. `defaultAuditEmitter` is a no-op.
  `createNatsAuditEmitter`, wired in whenever `NATS_URL` is set, publishes
  every propose/endorse/activate/revoke transition to the `audit.append`
  JetStream stream with `action_type: "admin_action"` and
  `actor_ref: "iam-service"` (none of `audit_log`'s other buckets --
  `rule_change`, `identity_action`, `vote_cast`, etc. -- fit a policy-engine
  grant/revoke event). `evaluate` calls never emit anything, by design.

Both seams' real implementations are exercised in
`src/collaborators.test.ts`, including the fail-closed HTTP behavior (a
non-2xx response and an unreachable host are each verified to still
return `false`, never confirm a role) and a real spawned `nats-server` for
the audit emitter, following the same pattern as
`identity-service`/`governance-role-service`'s own `collaborators.test.ts`.

No call site in this codebase is wired to call `/iam/evaluate` yet
(budget-service's `ledger_entry:record`, project-service's
`milestone:report`, governance-role-service's own
`approval:submit:operator`) -- that wiring is separate follow-on work per
ADR-025 §Consequences, same as every other open HTTP integration seam
ARCH-010/011/012 already document.
