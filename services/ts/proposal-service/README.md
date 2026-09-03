# proposal-service

TypeScript (ADR-019). Owns proposal lifecycle: drafting, constraints,
budget attachment, scope assignment, support gathering, constitutional
review, advancement to voting, resolution, and the FR-034 deadlock
resolution track. Spec:
[`.spec/technical/services/srv-004.md`](../../../.spec/technical/services/srv-004.md).
Route prefix `/proposals` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4004 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/proposal-service dev    # local dev server (tsx watch)
pnpm --filter @dd/proposal-service test   # vitest
```

## Implemented

Health contract (`/healthz`, `/readyz`) plus the full proposal lifecycle,
in-memory only (no database yet -- see `store.ts`):

- `POST /proposals` -- create a proposal (draft)
- `GET /proposals`, `GET /proposals/:id` -- list/read
- `POST /proposals/:id/constraints` -- add a shared constraint (DP-006)
- `PUT /proposals/:id/budget` -- upsert budget fields (DP-007)
- `POST /proposals/:id/scope-assignment` -- assign impact scope, deriving
  the population-scaled support threshold (FR-017); validates
  `scope_jurisdiction_id` against jurisdiction-service via an injected
  `JurisdictionClient` (400 if it doesn't exist -- ARCH-011 EC-5)
- `POST /proposals/:id/scope-challenges`,
  `POST /proposals/:id/scope-challenges/:challengeId/resolve` -- DP-020
- `POST /proposals/:id/support` -- record citizen support toward the
  threshold gate
- `POST /proposals/:id/advance` -- drives `draft -> gathering_support ->
  development -> voting`, enforcing the support threshold, the
  budget/scope completeness gate (FR-037), and constitutional review
  before voting
- `POST /proposals/:id/resolve` -- `voting -> approved/rejected`, or
  `-> archived` from any non-terminal status
- `POST /proposals/:id/deadlock/enter`, `POST
  /proposals/:id/deadlock/advance`, `GET /proposals/:id/deadlock` -- the
  FR-034 eight-stage deadlock resolution framework, entered only from
  `development`/`voting`, which blocks the normal advance/resolve
  endpoints while active and can resolve a proposal directly once
  `final_decision` is reached with an outcome

Seven integration seams are modeled as small injectable interfaces in
`integrations.ts`, defaulting to no-ops/permissive: `ConstitutionalReviewer`
(DP-034), `VoteSessionRequester` (voting-service session creation),
`AuditEmitter` (DP-036), `AssignmentChecker` (deadlock reviewer assignment,
DP-065), `ScopeEscalationRequester` (DP-020/DP-058 scope-challenge routing
to an independent review body), `JurisdictionClient` (scope-assignment
existence check, ARCH-011), and `ProblemStatusNotifier` (SRV-003's
open->proposing/proposing->closed problem-status sync, ARCH-012).
`ConstitutionalReviewer`, `AuditEmitter`, `JurisdictionClient`, and
`ProblemStatusNotifier` have real HTTP-calling implementations
(`createHttpConstitutionalReviewer`, `createHttpAuditEmitter`,
`createHttpJurisdictionClient`, `createHttpProblemStatusNotifier`);
`index.ts` wires the first two in whenever `AUDIT_SERVICE_URL` is set, the
third whenever `JURISDICTION_SERVICE_URL` is set, and the fourth whenever
`PROBLEM_SERVICE_URL` is set, falling back to the no-op/permissive defaults
otherwise so the service still runs standalone with zero configuration.
`createHttpJurisdictionClient` fails closed (treats an unreachable
jurisdiction-service as "does not exist") rather than silently accepting
the caller's assertion. `createHttpProblemStatusNotifier` is fire-and-forget
like every other cross-service notification in this codebase: it calls
problem-service's real `POST /problems/:id/status` when a proposal reaches
`development` (`proposing`) or when every proposal linked to a problem ends
up in a terminal status (`closed`), but a downed problem-service must not
block the proposal transition that triggered it. `AuditEmitter` also has a
real queue-backed implementation, `createNatsAuditEmitter` (ADR-023): when
`NATS_URL` is set it publishes to the `audit.append` JetStream stream
instead of calling audit-service's HTTP endpoint, and takes priority over
`AUDIT_SERVICE_URL`'s HTTP `AuditEmitter` when both are configured (
`ConstitutionalReviewer` still always uses `AUDIT_SERVICE_URL`, since
constitutional review is inherently a synchronous call, not a queue).
`VoteSessionRequester` and `AssignmentChecker` remain no-op-only --
voting-service and governance-role-service don't yet expose the endpoints
those seams would call.

`assignScope`, `fileScopeChallenge`, and `resolveScopeChallenge` all emit
through `AuditEmitter` (`proposal.scope_assigned`,
`proposal.scope_challenge_filed`, `proposal.scope_challenge_resolved`),
same as every other proposal-lifecycle mutation (ARCH-011 EC-37).
