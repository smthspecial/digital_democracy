# Security assessment — 2026-10-08

The current APIs allow unauthenticated changes to votes, audit records, protocol
approval state and delegations. These are release blockers for a pilot carrying
real civic data. Passing the existing suites does not establish these boundaries.

## Scope and method

Executed [TP-016](../../.spec/technical/test-plans/tp-016.md): requirements/backlog/
technical review, manual static inspection and dependency analysis first, then
bounded local HTTP penetration probes. Baseline commit:
`24765a0cd2c32aabbcae55c0272cf754142a6689`, with the existing uncommitted CI,
passkey harness, README, TASK-002 and dependency changes included. No application
fixes or dependency upgrades were made during this assessment.

The probes start the current Go binary and TS runtime on temporary ports, using
synthetic data. Go ran with both memory and migrated Postgres stores. TS ran with
its actual Prisma app/worker roles against a separate disposable database.
Identity/competency HTTP seams return active fixture responses. **TS assurance
tests use a validator fixture returning valid T1/T2 contexts**, so they confirm
missing downstream tier enforcement, not a bypass of real passkey authentication.
The real auth protocol was separately exercised by the existing Go/browser tests.
No deployed system or unrelated local database was tested.

## Findings

Severity reflects impact if the affected surface is reachable; it is not CVSS.
Evidence is in [memory results](results-memory.json) and
[Postgres results](results-postgres.json), keyed by case name and finding ID.
Bearer tokens and one-time secrets are redacted.

| ID | Severity | Evidence | Finding | Tracking |
|---|---|---|---|---|
| SEC-01 | Critical | HTTP, both Go stores | Anonymous voting control and arbitrary eligibility | [BUG-005](../../.spec/backlog/tasks/bug-005.md) |
| SEC-02 | Critical | HTTP, both Go stores | Audit forgery and fabricated protocol approvals/release | [BUG-006](../../.spec/backlog/tasks/bug-006.md) |
| SEC-03 | High | HTTP, both Go stores; competency fixture | Delegation impersonation and unauthenticated revocation | [BUG-007](../../.spec/backlog/tasks/bug-007.md) |
| SEC-04 | High | Real TS HTTP/Postgres; validator fixture | T1/T2 governance approval accepted despite T3 requirement | [BUG-008](../../.spec/backlog/tasks/bug-008.md) |
| SEC-05 | High | Real TS HTTP/Postgres | Anonymous worker scans disclose pending IDs and enable expensive work | [BUG-009](../../.spec/backlog/tasks/bug-009.md) |
| SEC-06 | High | HTTP, both Go stores | Voting deadline and option immutability not enforced | [BUG-010](../../.spec/backlog/tasks/bug-010.md) |
| SEC-07 | Medium | Static + bounded HTTP | Missing Go payload limits and abuse controls | [BUG-011](../../.spec/backlog/tasks/bug-011.md) |
| SEC-08 | High | Advisory scans; exploitation not attempted | Vulnerable dependencies and old build toolchain | [BUG-012](../../.spec/backlog/tasks/bug-012.md) |
| SEC-09 | High | Deployment files only | Deployment examples lack the assumed trust/DB boundaries | [BUG-013](../../.spec/backlog/tasks/bug-013.md) |
| SEC-10 | Informational | HTTP + ADR-040 | Signed requests can be replayed inside their time window | Existing ADR-040 limitation |

### SEC-01 — anonymous voting and arbitrary eligibility

`main.go:182` mounts voting with metrics middleware only. No voting handler
validates a citizen session or workload identity. The local chain returned:

1. `POST /voting/sessions` → 201 for caller-chosen proposal/jurisdiction.
2. `POST /voting/sessions/:id/open` → 200.
3. `POST /voting/sessions/:id/tokens` → 201 for an arbitrary, nonexistent UUID.
4. `POST /voting/ballots`, including a deliberately invalid bearer → 201.
5. Close, tally and certify → 200, with final `status=certified`.

The arbitrary choice outside the option set became the tally winner. This breaks
AUTH-010's T3 ballot requirement and system-only operations. TASK-005 already
tracks deriving eligible citizens; it does not cover the missing auth boundary.
Require allow-listed service identity for lifecycle/token operations and the
specified assurance/proof boundary for casting. Derive eligibility from verified
jurisdiction state and validate ballot format/choice proofs. Preserve the secrecy
requirements of FR-003 when designing the casting boundary.

### SEC-02 — forged audit records and unilateral protocol gate release

`internal/audit/handlers.go:53` accepts arbitrary `actor_ref`. An anonymous
`vote_certified` event claiming `voting-service` returned 201; `/audit/verify`
reported `valid=true`. Both stores construct a public SHA256-based `sig:` value
(`store.go:71`, `pgstore.go:94`), not a keyed signature. Chain continuity provides
no proof of who submitted an event.

An anonymous caller registered a change with past delay/visibility timestamps,
submitted both required refs under the **same** `approver_ref`, then released it
with 200/`status=released`. `service.go:169` accepts approval refs without checking
their authoritative record, role or independent holder. No configuration switch
adds those checks. This test confirms release of the local gate record, not a
production deployment or constitutional rule change.

Authenticate audit producers, derive actor attribution from verified context,
and use genuine keyed signatures if signature fields assert provenance. Resolve
approval records from governance-service, enforce independent authorized holders,
and derive delay/visibility from authoritative state. Trace: AUTH-012, US-048,
FR-065, ADR-040. Checks remain necessary even behind a mesh.

### SEC-03 — delegation impersonation and header omission bypass

Anonymous creation accepted an arbitrary `delegator_id`. Revocation without
`X-Citizen-ID` returned 200 with a populated `revoked_at`. The handler forwards
that header (`handlers.go:80`); `Service.Revoke` skips ownership comparison when
it is empty (`service.go:126`). Public delegation records reveal the IDs needed
for a forged nonempty header too.

The competency seam was deliberately active in these probes. This does not prove
an attacker can bypass a configured competency service; it proves that a valid
expert check does not establish the delegator's consent. Static review additionally
found `NewService` defaults to allow-all competency when the seam is omitted,
contrary to the README's fail-closed claim. Require a validated T2 citizen, bind
creation/revocation to that citizen and reject missing identity/competency config.
Trace: AUTH-010, US-043, US-044, FR-056.

### SEC-04 — assurance is collected but never enforced by TS domains

`common/auth-context.ts:73` stores assurance; `RequiredCitizenId` checks only
citizen identity. No domain uses `assuranceTier`. With a seeded active auditor
and a validator fixture returning T1 then T2, the real approval controller and
Postgres accepted each request with 201. Anonymous, spoofed-header and invalid
token versions returned 401. This is an assurance gap, not the historical claim
that TS approvals have no authentication at all.

Add a small minimum-tier guard for AUTH-010 routes, including T3 approvals and
T2 citizen mutations, while retaining active identity, role, ownership and COI
checks. Reject unknown tiers and preserve step-up signaling. Trace: AUTH-010,
ADR-014, ADR-040. Complete COI/assignment enforcement still needs its own review.

### SEC-05 — public administrative identity queries

`identity.controller.ts:74` exposes duplicate scans without a guard. Two
synthetic pending registrations with similar handles were anonymously discoverable
as a pair of citizen IDs. The burst query also returned 200 anonymously. These
functions read via the worker connection (`duplicate-detection.service.ts:54,80`),
bypassing the own-identity read boundary. Duplicate detection compares every pair
and computes edit distance; its cost grows quadratically in citizen count.

Restrict the review-facing operations to authorized reviewers/workers, make
expensive scans scheduled/bounded, and avoid unnecessary pending-identity
disclosure. Only two synthetic candidates were tested; exhaustion was not attempted.
Trace: US-003, FR-005, NFR-007, ADR-034 D6.

### SEC-06 — lifecycle integrity remains vulnerable after auth is added

`CastBallot` checks stored `status=open`, not the actual deadline. A session whose
`closes_at` was already past was opened and accepted a ballot. Options were
inserted after opening and again after certification (both 201). `addOption`
checks existence only. Fix deadline and option-freeze rules independently of
authentication and enforce them transactionally in both stores. Trace: US-024,
US-033, US-034, SRV-008, DP-016/DP-047. Full cryptographic tally correctness is
outside this implementation's current placeholder counting layer.

### SEC-07 — bounded input and resource abuse

A single 1 MiB option description was accepted and persisted in both stores.
Go decoders have no body-size/field-size limits; signed auth requests call
unbounded `io.ReadAll` after service-name/time checks but before signature
verification (`internal_auth.go:45`). There is no application rate limiter in
either entrypoint. Audit/session list and verify operations also have unbounded
work/output by default. TS uses DTO validation and Express's normal JSON limit;
the demonstrated Go size issue must not be generalized to TS.

Apply per-route body/field/batch limits, cap list sizes and expensive work, and
rate-limit public authentication and registration endpoints. Retain server
timeouts (already present in Go). No flood or denial-of-service test was run.

### SEC-08 — advisories require conditional triage

`pnpm audit` returned **98 distinct advisory IDs**: 7 critical, 54 high, 33
moderate, 4 low. Its metadata reports **103 affected occurrences** across
dependency paths (7/56/36/4); these are not 103 unique vulnerabilities or proved
exploits. See [dependency snapshot](dependency-advisories.json).

Examples: Next 14.2.35 has critical AVIF/image-optimizer and Windows-hosting
advisories; the Windows condition does not apply to this Linux test host, and
AVIF processing was not exercised. The maintainer lists patched Next versions
15.5.24 and 16.3.3 for these two issues. Other critical reports concern tar in
Expo tooling, tinypool in Vitest, shell-quote in mobile tooling and proxy-addr
under the Express dependency. `trust proxy` is not enabled in the current TS
entrypoint, so proxy spoofing is not established here. Upgrade to compatible,
maintained patched versions and separate runtime risk from tooling exposure.

The official `govulncheck` v1.8.0 scan explicitly selecting **Go 1.25.0** found
**29 advisories on callable paths**: 27 standard-library advisories plus
`pgx/v5` 5.6.0 and `x/text` 0.40.0. See [Go scan](govulncheck.txt). An initial
`go run ...@latest` used Go 1.26.8 to build/run the scanner and showed only the
two modules; the explicit project-toolchain scan corrected that undercount.
Update the compiler/toolchain as well as module versions and rescan.

For pgx, the upstream advisory requires nondefault simple protocol, a dollar
quoted SQL string containing apparent placeholders, and attacker-controlled
arguments. The reviewed generated queries use parameters and the migrations
are embedded trusted SQL; no HTTP SQL injection was demonstrated. The x/text
advisory concerns a crafted Nickname profile transformation; the scanner traces
it through Postgres setup, but attacker control of those conditions was not
established. Fix versions: pgx >=5.9.2, x/text >=0.41.0, plus a maintained patched
Go release. Static reachability alone is not proof that the prerequisites hold.

Sources: [pgx advisory](https://pkg.go.dev/vuln/GO-2026-5004),
[x/text advisory](https://pkg.go.dev/vuln/GO-2026-6629),
[Next AVIF advisory](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4),
[Next Windows advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36).

### SEC-09 — deployment assumptions are absent from the supplied examples

Static findings, not observations of a deployed cluster:

- Compose publishes API, NATS, database and monitoring ports on all interfaces.
  NATS starts without auth/subject ACL configuration; database/monitoring examples
  have development passwords. Bind development services to loopback and configure
  actual service identity and broker permissions before shared use.
- Go uses one database URL/pool to migrate and serve traffic. Compose supplies the
  Postgres bootstrap superuser `dd`; it bypasses RLS despite the migration's
  `FORCE ROW LEVEL SECURITY`. Use separate migration and restricted runtime roles.
- Helm ingress allows all namespaces and relies on a mesh `AuthorizationPolicy`
  absent from the repo. Its HTTPRoute forwards entire prefixes with no distinction
  between public reads and privileged writes. Gateway example is HTTP-only.
  Provide and verify TLS/workload policy for the actual two-app topology.

A network policy does not prove a human's role, assurance or eligibility. The
domain checks above must still run. Trace: NFR-007, AUTH-012, ARCH-023, ADR-040.

### SEC-10 — signed request replay is a known design limit

Replaying the identical valid `/auth/revoke-all` request inside its timestamp
window returned 200 twice. The synthetic citizen had no sessions, so no additional
revocation impact was demonstrated. ADR-040 explicitly says time windows are
not general replay protection. If these signatures are used for non-idempotent
operations, add a consumed request ID or operation-specific idempotency record;
do not describe timestamp checking as single-use protection.

## Validation and limitations

- Go `go vet ./...`: passed.
- Go app `go test ./... -count=1 -v`, with required Postgres and Chromium tiers:
  77 tests passed, including real browser WebAuthn in memory and Postgres and
  the audit-consumer integration test against a spawned real NATS server.
- Shared eventbus suite: passed, with real NATS test servers available. These
  functional bus tests do not verify broker authorization or subject ACLs.
- TS required-database suite: **35 files / 429 tests passed**, no skipped tests.
- Local penetration runner: **33 memory + 46 Postgres/TS cases** completed with
  no unexpected responses; 42 reproduced vulnerability/known-limit observations
  and 37 rejection/positive-control checks, counting repeats across stores.
- Defended controls include one-time ballot token replay rejection, presence-only
  ballot verification, disabled legacy login/MFA, unsigned internal auth rejection,
  verifier callback rejection, TS citizen-header spoof rejection, registration
  extra-field rejection, and absence of the historical reputation write route.
- Narrow static searches found no matching committed private-key/AWS/GitHub-token
  signatures; only `.env.example` files are tracked. This was not a full-history
  or entropy-based secrets scan. Development credentials remain in examples.
- No obvious unsafe raw SQL, command execution or HTML injection sink surfaced
  in the searched app/client code. This is not a blanket absence claim. Citizen
  clients are currently placeholders; their future auth flows were not assessed.
- Untested: live TLS/mesh policy, NATS ACLs, container-image CVEs, physical passkeys,
  real external identity proofing, recovery, full election crypto, load resilience,
  and the complete COI/assignment permission catalog.

## Remediation order

1. Close anonymous Go voting/audit/delegation mutations; protect administrative
   identity operations. Enforce real citizen or allow-listed service context.
2. Derive eligibility and approvals from authoritative data; enforce T2/T3,
   independent approvers, deadlines and option immutability.
3. Update runtime/tooling dependencies and Go; separate migration/runtime DB
   privileges; configure local port bindings and actual deployment identity/TLS.
4. Add bounded input/work and rate controls. Convert these exploits to regression
   tests expecting denial, then rerun TP-016 before a real-data pilot.

## Reproduction

See [README](README.md) for disposable setup and commands. The probe runner exits
successfully when responses match the recorded assessment (including vulnerable
behavior); **exit zero is not a security pass**. It is not a CI release gate.
