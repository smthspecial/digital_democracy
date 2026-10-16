# Production-readiness implementation — 2026-10-08

Local cryptography continuation (2026-10-14): the
[test-only blind-credential experiment](../cryptography/README.md) uses pinned
CIRCL/RFC 9474 and retains its own [execution results](../cryptography/results.json).
This is additional component feasibility evidence; TASK-007/008 and the complete
production protocol remain open.

Production is not qualified or deployed. This checkpoint implements and tests
local security controls, image gates, release packaging and a cryptography
component prototype. Existing requirements are unchanged. The remaining
acceptance gates are tracked in REL-002 / TASK-006 through TASK-021.

## Implemented behavior

- Both API images default to `APP_ENV=production`. Startup rejects unverified
  database transport, plaintext external service URLs, short development
  secrets and migration credentials in runtime settings. Go accepts verified
  broker TLS with workload-specific client certificates; TypeScript refuses
  disabled global TLS verification. Development fixtures opt in explicitly.
- Production voting opening, current credential issuance, casting, tallying and
  certification fail closed. Casting returns 503 before contacting a verifier;
  a URL or configuration flag cannot approve the placeholder protocol. Removing
  this gate requires the reviewed implementation and evidence from TASK-007–012.
- Prisma has a dedicated non-root migration image retaining its CLI. Runtime
  images exclude unused package managers, application test/fixture source and
  administrative migration inputs. Go uses supported Alpine 3.24.2; image builds
  update Alpine packages. The vulnerable build-tool pin is upgraded to pnpm
  10.34.6. BUG-015, BUG-016 and BUG-017 record the new findings and retests.
- CI builds/scans Go, TypeScript, Prisma migration and web artifacts. Pinned
  Trivy 0.75.0 rejects unsupported operating systems and HIGH/CRITICAL findings.
  Lower-severity notices require exact, dated reviews. Scanner/patch/exception
  failures block the gate. Weekly rescans and manual workflow dispatch are added.
- [Release preparation](../../infra/release/prepare.py) requires registry image
  digests and renders both runtimes with one release identity, separate TLS
  migration Jobs/policies, per-namespace renewable HTTPS Gateways/Certificates,
  projected trust/identity Secrets and gateway maintenance denial. Checksums
  bind the reviewable bundle; preparation performs no cluster writes. Every
  resource explicitly targets its intended runtime namespace (BUG-019).
- [The coordinator](../../infra/release/rollout.py) requires a private unchanged
  bundle and executable target-specific preflight/drain/verify/revoke/resume
  hooks. It waits for both migrations before applying both runtimes and for both
  rollouts before qualification/revocation. Failed steps retain maintenance;
  no automatic schema rollback is attempted. Backend ArgoCD auto-sync is
  disabled to prevent independent signing-format promotion.

## Executed evidence

| Check | Observed result | Evidence |
| --- | --- | --- |
| Application regression | 95 top-level Go tests including real NATS and both browser passkey cases; 446 TypeScript tests. Required database tiers ran against fresh restricted-role TLS databases. | [541 test results](application-tests.json) |
| Static analysis | Go vet, TypeScript lint/typecheck and frozen-lockfile builds passed; Go reachability scan has no reachable/imported vulnerable packages. | [Go scanner output](govulncheck.jsonl) |
| Dependency patches | All 10 exploit/positive regressions pass; raw scan still reports 2 high and 1 moderate upstream advisories, all covered by exact local patches. | [Raw advisories](dependency-advisories.json), [regressions](dependency-regressions.txt), [exception register](../security/dependency-exceptions.json) |
| Exact image scans | Four final artifacts pass; supported OS, zero HIGH/CRITICAL findings. TS runtime, migration and web have zero notices. Go retains a module-level OpenPGP maintenance notice with exact dated review. | [Identities and 11 container checks](images/summary.json), [scanner/database timestamps](scanner-version.txt), raw `images/*-scan.json` and gates |
| Broker TLS | Verified workload connects; wrong host/CA, missing/expired client certificate, unlisted identity and plaintext downgrade are rejected by the real NATS fixture. | [Go broker cases](application-tests.json), [test](../../packages/go/eventbus/tls_test.go) |
| Database TLS | Four positive/negative controls passed against TLS-only PostgreSQL. | [Results](database-tls-results.json), [runner](database_tls.py) |
| Separate migrations | Both exact migration artifacts deploy independently over verified TLS; wrong host/CA, plaintext and ambiguous TLS settings fail. Ten controls passed. | [Results](migration-results.json), [runner](migration_checks.py) |
| Release safeguards | Eleven unit tests cover image gates/review expiry, migration separation, maintenance, both migration/readiness gates, failed/partial rollout stopping and bundle tamper/privacy rejection. Both Helm lint runs and all 18 rendered resource namespace/release/digest checks pass. | [Tests](test_rollout.py), [render evidence](release-render-results.json), [runbook](../../infra/release/README.md) |
| Workload templates/broker ACLs | 31 rendered infrastructure and disposable broker controls pass after the 2026-10-10 local update, including the web loopback binding and gateway exclusions for signed worker reads; this does not demonstrate live Kubernetes enforcement. | [Results](infra-validation.json) |
| Cryptographic component prototype | Five standard 4096/256-bit group checks pass: real encryption proofs, tamper/domain rejection, encrypted tally/published-record reload and 2-of-3 compensated trustee decryption. | [Results](cryptography-prototype-results.json), [assessment and reproduction](cryptography-assessment.md) |
| Encrypted recovery fixture | Six checks pass: both databases decrypt exactly, reject tampered archives before restore and restore every public table with matching counts/data digests. | [Results](backup-restore-results.json), [runner](backup_restore.py) |
| Local cluster attempt | Kubernetes booted; kube-proxy/CNI could not start because the host exhausted its inotify instance limit. Host settings were unchanged and the disposable cluster was removed. | [Failure evidence](staging-attempt.json), [next fixture/runbook](../../infra/staging/README.md) |

Local image identities are **image configuration digests**, not published
registry manifest digests. No image was pushed or claimed promotable by digest.
The release preparer requires actual registry digests when the target/registry
is confirmed. Retain CI artifacts for the eventual exact published release.

## Dependency maintenance

`pnpm why` places node-forge and braces under Expo/Metro build tooling and
sprintf-js under the React Native CLI's argparse chain:
[paths](dependency-paths.txt), [sprintf path](sprintf-dependency-paths.txt).
None appears in the four image package inventories. Mobile native/web bundle
exposure still requires its own packaged-bundle inspection; transitive workspace
classification alone does not prove mobile runtime absence.

Published versions were rechecked: node-forge 1.4.0, braces 3.0.3 and sprintf-js
1.1.3 still fall within the raw advisory ranges; the installed sprintf-js copy
is 1.0.3. No published upstream fix is claimed. Preserve exact local patches
and their ten regressions. Patch SHA256, exact version/GHSA and expiry are
enforced by `dependency-policy.mjs`. The three patch exceptions and the separate
Go image notice expire after **2026-11-07**. The responsible role is recorded;
a named maintainer remains an input to TASK-006. Unexpected advisories, changed
patches or expired reviews fail CI.

## Remaining release gates

| Tickets | Current boundary |
| --- | --- |
| TASK-006 | Confirm cluster/context, owned domain/issuer/registry, deployment population and recovery targets; name trustees, independent reviewer, maintainers and incident/release owners. No pre-existing Kubernetes context was configured locally. |
| TASK-007–012 | Component prototype and proposed ADR-042 exist. No approved complete remote-voting protocol, anonymous credential/submission system, independent trustee ceremony, integrated encrypted tally, receipt-freeness or independent design/implementation review exists. Required ranked/scored methods remain unqualified. |
| TASK-013 | Blocked on a usable staging host/cluster. The local watcher restriction cannot be lifted in this environment. No live network/mesh identity or ingress result is claimed. BUG-018's gateway worker-read exclusions are fixed in templates and remain in testing for live denial/normalization/positive controls. |
| TASK-014 | Local verified DB/broker TLS and renewable certificate manifests are tested. Actual issuer/DNS/gateway provisioning, renewal under traffic, expiry alerts and CA/workload rotation remain open. |
| TASK-015 | Fresh restricted-role databases and encrypted restore fixtures work. Existing role migration, independently verified old audit provenance, production key custody/rotation and offsite/region recovery remain open. The synthetic backup passphrase and archives were co-located only for the drill. |
| TASK-016 | Exact maintenance/expiry policy and upstream checks exist. Named ownership and packaged mobile exposure/retirement assessment remain open. |
| TASK-017 | Local four-artifact gate passes; CI changes await remote execution. Registry publication, actual release digests and any approved production ballot component remain unqualified. |
| TASK-018 | Bundle/coordinator and failure sequencing tests exist; two real migration artifacts pass local TLS tests. Live Job failure/interruption, target-specific hooks, draining all signers/writers, credential disposal and rollback/forward-fix/restore rehearsal remain open. |
| TASK-019 | Distributed trusted edge limits, required queued workers, multi-replica voting races, 100,000-session p99 targets, regional failure/restore and operational alerting remain unimplemented/unqualified. Local request caps are not national capacity evidence. |
| TASK-020–021 | Local static-then-bounded fixture results exist. Full staging penetration matrix, independent review, soak/capacity/recovery, final promotion rehearsal and operational handover remain open. |

No production database, broker, cluster, DNS record or real voter was modified
or probed. Fixture databases/clusters and synthetic cryptographic key material
are disposable; private keys/passwords are outside this repository. Production
voting stays disabled and REL-002 stays unreleased.

## Solo local development checkpoint — 2026-10-10

The user selected local development and works alone. BUG-020 is complete:
`python3 infra/compose/local.py up` builds the images, applies Go and Prisma
migrations as separate jobs, and starts both APIs plus web after success.
Development mode is explicit, the verifier remains unset, and `.env.local`
contains private stable random secrets. Postgres and JetStream have persistent
project-specific volumes. Production reviewer/trustee/infrastructure gates do
not block this development workflow.

[35 live checks](local-development-results.json) pass: all endpoints are ready,
all listeners bind loopback, runtime logins are restricted, cross-database and
anonymous worker access fail, and a complete stop/start preserves synthetic
database data, all 4 Go/13 Prisma migration records and local signing keys.
The temporary probe database was removed. Two additional migration-failure
tests pass (13 release/local unit tests total). An initial transient Go database
connection timeout prompted bounded runtime startup retries; the full repeat
passed. Migration jobs never retry automatically.

The stack remains running at [Go](http://localhost:5000/readyz),
[TypeScript](http://localhost:4000/readyz) and [web](http://localhost:3001/).
Web is currently a project placeholder. Reproduce the restart/access checks
with `python3 testing/production-readiness/local_checks.py` after starting the
stack; it restarts only the `dd-local` project and retains its volumes.

The local report records newly built image configuration digests. The earlier
2026-10-08 application and exact-image scan artifacts remain separate historical
evidence; they are not scans of these newly built local image identities.

## Local audit continuation — 2026-10-14

[Audit checkpoint](audit-next-items-results.json) records the next local slices
of TASK-016 and TASK-019, with unchanged requirements and production crypto gates.

- **BUG-021:** committed tallies remain stable across retries, concurrent writers
  and reconstructed Services/independent database pools. The persisted first
  result replaces the process mutex/cache; concurrent computation before that
  first commit is still possible and is not a distributed-worker guarantee.
- **BUG-022:** ballots share the election-row lock while retaining exclusive
  credential locks. Independent tokens proceed together; close waits for
  in-flight writes. Sixteen issuance/spend attempts accept exactly one ballot.
  Failure injection at the credential-spend write rolls back the earlier ballot
  insert, and replacing an unavailable pool permits a safe retry.
- Regenerated repositories match current SQL query bounds/predicates. The
  1,001-session fixture confirms the 1,000-row public listing cap.
- All **95 Go tests** passed with the race detector and required database/NATS
  tiers; two browser-passkey cases were skipped. Go vet/build, seven bundle-gate
  tests, three dependency-policy tests, ten exploit/positive patch controls,
  mobile lint/typecheck and thirteen release/local tests passed.
- Fresh Android/iOS exports contain none of the three patched packages in either
  [Hermes](mobile-hermes-bundle-results.json) or
  [JavaScript](mobile-javascript-bundle-results.json) module inventories. CI now
  exports/inspects the default native bundles and retains digest evidence.
  Source maps are used for inspection and are not uploaded by this step.
- The [dependency review](dependency-review-20261014.json) checks current upstream
  versions and every active resolved copy. The
  [fresh raw scan](dependency-advisories-20261014.json) still reports two high and
  one moderate advisory, all covered by exact local patches. Exceptions and the
  2026-11-07 deadline are unchanged; no new exception or guessed upgrade was added.

The disposable Postgres container was removed. Other local containers were not
modified. Pool/Service reconstruction is not a deployed process/database restart
drill, and these bounded cases do not measure capacity or regional recovery.
Signed APK/IPA/native-library qualification, final runtime image rescans, named
production maintenance ownership, live mesh/TLS and reviewed anonymous encrypted
voting remain open. TASK-016/TASK-019 remain in progress and REL-002 is unreleased.

Reproduce the native dependency gate after installing the frozen lockfile:

```bash
CI=1 EXPO_NO_TELEMETRY=1 pnpm --filter @dd/mobile exec expo export \
  --platform android --platform ios --source-maps --max-workers 2 \
  --output-dir /tmp/dd-mobile-export
node testing/security/mobile-bundle-audit.mjs /tmp/dd-mobile-export
node --test testing/security/mobile-bundle-audit.test.mjs
pnpm test:security-dependencies
```

Run voting checks with `TEST_DATABASE_URL` pointing only at a disposable database
(the existing Postgres test helpers truncate their fixture tables):

```bash
cd apps/api-go
REQUIRE_DB_TESTS=1 go test -race ./internal/voting -count=1
```
