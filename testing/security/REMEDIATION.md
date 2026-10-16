# Security remediation — 2026-10-08

The original assessment is retained in REPORT.md. BUG-005 through BUG-014 track
all ten observations, including the previously informational replay limitation.
No production service was probed or deployed; existing user edits were retained.

| Ticket | Correction | Evidence |
|---|---|---|
| BUG-005 | Signed voting lifecycle; real citizen T3 and token ownership; verified jurisdiction roster; fail-closed ballot proofs; frozen-option tally validation; unlink ballot token | Go HTTP/PG regressions; real TS eligibility SQL; local penetration runner |
| BUG-006 | Authenticated audit producers; producer-bound signatures and NATS envelopes; Ed25519 chain signatures/public key; authoritative independent three-type approvals; server review delay; reject legacy/self-selected gates | Audit HTTP/PG/NATS and protocol gate regressions |
| BUG-007 | Validated citizen context; delegation owner checks on create/revoke; missing competency fails closed | HTTP ownership and competency regressions |
| BUG-008 | T2 citizen writes; T3 governance/IAM/revocation and residency/scope review; unknown assurance denied | Real Nest assurance regressions and complete TS integration suite |
| BUG-009 | Signed worker-only identity scans; bounded input population/handles/output | Real TS controller guards and local scan/replay probes |
| BUG-010 | Atomic ballot deadline and session checks; freeze options at opening; atomic state transitions | Memory and PG deadline/option tests |
| BUG-011 | 64KiB Go bodies, strict JSON, field/page limits, socket-peer rate limits, bounded public DB reads, oversized synchronous jobs denied | Go/TS resource regressions and penetration probes |
| BUG-012 | Go 1.27.1, patched pgx/x/text/x/crypto, supported Next/Expo/Nest/Prisma/tooling upgrades; three narrowly patched dependencies and an exact-advisory CI gate | Dependency exploit regressions, scanner snapshots, lint/typecheck/build |
| BUG-013 | Loopback development ports; authenticated NATS subject ACLs; separate migrations; per-app DB credentials/CONNECT isolation; TLS Gateway and workload policies for two runtimes | Rendered Helm, real broker tests, fresh database bootstrap and runtime probes |
| BUG-014 | Required random nonce; signed producer/query; persistent one-time consumption across replicas | Go/TS replay tests, restricted PG cross-instance test, local replay/substitution probes |

## Validation

`remediation-validation.json` records final counts and status. The local regression
files record expected rejection status for every attack and successful signed
controls. Test-only proof/session fixtures are explicitly isolated from runtime
code. Browser tests perform real Chromium WebAuthn ceremonies on both stores.

All ten tickets are done. Final verification passed 93 Go tests and 437 TS tests,
73 local attack/control checks, 29 infrastructure checks, six database isolation
checks, four migration rollback checks and ten dependency exploit regressions.
All three container images built; eight non-root/health/anonymous-denial smoke
checks passed. Lint, typecheck, production builds and Go vet passed.

The raw pnpm audit still reports three upstream versions with no published fix:
node-forge, braces and sprintf-js. Reproducible pnpm patches reject malformed
nested RSA DigestAlgorithm data and bound recursion/format precision. The
security gate runs their regressions and permits only those exact advisory/version
pairs; it fails for other advisories. It does not relabel the raw audit as clean.
See dependency-audits-after.json and patches/. References:
[forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv),
[braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
[sprintf advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

The Go scan reports no vulnerable imported packages or reachable symbols. Its
module-level notice for unmaintained `x/crypto/openpgp` is retained: the application
does not import or ship that package. The fixable SSH module notices were removed
by upgrading x/crypto. No container-image advisory scan or live mesh test was run.

The remaining readiness work is planned in [REL-002](../../.spec/planning/releases/rel-002.md),
with TASK-006 through TASK-021 and [TP-017](../../.spec/technical/test-plans/tp-017.md).
These items are planned; the assessment results above are their baseline.

## Deployment and operational prerequisites

- Generate independent secrets using the root `.env.example`; Compose refuses
  missing infrastructure passwords. Use URL-safe hex values or encode passwords.
- Initialize new development storage with the supplied bootstrap script. Existing
  volumes retain their old roles/passwords and need explicit credential/CONNECT
  migration; replacing the file does not rewrite a running database.
- Run Go migrations in a separate job with `MIGRATE_ONLY=1` and
  `MIGRATE_DATABASE_URL`. Run Prisma migrations separately too. Runtime Secrets
  contain only per-app restricted database URLs, never the migration login.
  Compose bootstrap's policy roles cannot log in; its three application logins
  connect only to their own database. Direct superuser runtime URLs are rejected.
- Upgrade both runtimes and the trusted identity verifier together. ADR-041
  requires producer + method + path/query + timestamp + nonce + body hash in
  signed bytes. Old clients are rejected. PostgreSQL replay rows are shared
  across replicas and retained through the complete timestamp validity window.
- Keep a stable random AUDIT_SIGNING_KEY and pin its published Ed25519 public key.
  Old placeholder signatures intentionally fail verification; do not silently
  re-sign untrusted history. Restore/migrate independently verified history through
  an explicit operational process before relying on a persistent old audit chain.
- Production requires an installed/injected mesh, a NetworkPolicy-capable CNI,
  provisioned Gateway certificates, matching workload principals and dependency
  labels, and TLS to Postgres/NATS. The manifests were rendered, not deployed.
  Shared HMAC authentication alone does not isolate a compromised trusted runtime.
- BALLOT_VERIFIER_URL must point to a real cryptographic election component.
  It receives only the election ID, ciphertext and proof, never citizen/token
  identity. Missing validation denies casting. The current counting step rejects
  values outside the frozen option identifiers; full threshold decryption is still
  required for encrypted production elections. The test proof fixture is not a
  production cryptography implementation.
- Protocol registrations now take only change_ref and enforce a 24-hour review
  window. Release resolves current three-type independent approvals; fake approval
  refs and malformed legacy gate policies fail closed.
- Public Go lists are capped at 1,000 records (audit log defaults to 100); this
  pilot API is not a full archival export. Chain verification over 10,000 entries,
  duplicate scans over 500 identities/1,000 signals, oversized legacy handles,
  and constitutional reviews over 1,000 rights require offline processing and
  fail closed. Rate limits are per process/socket peer; a trusted deployment edge
  must add distributed per-citizen limits for production scale.
