# Security verification

[Remediation](REMEDIATION.md) · [Current validation](remediation-validation.json) ·
[Original assessment](REPORT.md) · [Plan](../../.spec/technical/test-plans/tp-016.md)

Use `regression.py` for the fixed application. Build the Go binary at
`/tmp/dd-security-api-go` and the TS application with `pnpm build`, then run:

```bash
python3 testing/security/regression.py --output /tmp/security-regression-memory.json
pnpm test:security-dependencies
```

For Postgres, create disposable databases, apply TS migrations and run the Go
`MIGRATE_ONLY=1` job first. Give the runner a restricted `--database-url`; add
`--ts-app-url` and `--ts-worker-url` to test the compiled TS application too.
The runner starts only loopback APIs and stops them on exit. Full Go/TS
integration suites and browser ceremonies are required as described in TP-016.
`infra-checks.py` requires Helm at `/tmp/dd-security-tools/helm` and the repository
NATS test binary; it renders manifests and tests a disposable broker.
The retained `container-checks.py` uses only the named disposable bootstrap
database fixture on loopback port 55484 and the three `dd-security-*` test images;
create that fresh fixture before using it. It removes its smoke containers.
Use a fresh audit chain when switching between tests with ephemeral signing keys
and the penetration runner. On machines with restrictive SWC cache validation,
set `SWC_NATIVE_BINDING_CACHE` to a private temporary directory with mode 0700.

The following retained instructions describe the original vulnerable snapshot;
`probe.py` is historical evidence and is not a gate for the fixed application.

# Local security assessment

[Report](REPORT.md) · [Plan](../../.spec/technical/test-plans/tp-016.md) ·
[Validation](validation.json)

The runner starts/stops its own local APIs and fixture server. It does not accept
an existing target API URL. Use a **new disposable database**: it inserts synthetic
data and runtime migrations can modify schema. Never supply an existing project
or production database. Database URLs must point to loopback. APIs currently bind
all interfaces on temporary ports; run in a trusted isolated local environment.

Install the workspace dependencies first. Build the current Go app:

```bash
cd apps/api-go
go build -o /tmp/dd-security-api-go .
cd ../..
python3 testing/security/probe.py --output /tmp/security-memory.json
```

For the persistent tier, start a dedicated container (Podman; Docker equivalent
also works). The example password is test-only and the port is loopback-only:

```bash
podman run -d --rm --name dd-security-postgres \
  -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=dd_security -e POSTGRES_PASSWORD=dd_security_local \
  -e POSTGRES_DB=api_ts docker.io/library/postgres:16-alpine
podman exec dd-security-postgres pg_isready -U dd_security
podman exec dd-security-postgres createdb -U dd_security api_go
MIGRATE_DATABASE_URL=postgres://dd_security:dd_security_local@127.0.0.1:55432/api_ts \
  pnpm --filter @dd/api-ts exec prisma migrate deploy
python3 testing/security/probe.py \
  --go-database-url postgres://dd_security:dd_security_local@127.0.0.1:55432/api_go \
  --ts-admin-url postgres://dd_security:dd_security_local@127.0.0.1:55432/api_ts \
  --ts-app-url postgres://api_app:api_app_dev@127.0.0.1:55432/api_ts \
  --ts-worker-url postgres://api_worker:api_worker_dev@127.0.0.1:55432/api_ts \
  --output /tmp/security-postgres.json
podman stop dd-security-postgres
```

Wait for `pg_isready` success before continuing. The container has no persistent
volume; stop removes its synthetic databases. API logs are temporary files whose
paths the runner prints. Do not run the project database suites concurrently with
the probes: those suites truncate shared fixtures.

The identity/competency seam returns active responses; TS assurance probes use
a test validator serving T1/T2 session contexts. These boundaries are described
in the report. No test fixture is linked into application code.

The runner reproduces the **assessment**, including vulnerable behavior. Exit zero
means the observations matched, **not that the system is secure**. A fixed system
will intentionally produce unexpected responses until those cases are changed
into regression tests expecting denial. This script is not a release gate.

Dependency snapshots are time-specific. Recheck with `pnpm audit --json` and the
official `govulncheck` scanner using the application build toolchain, not an
implicitly upgraded scanner toolchain. Install scanner binaries under `/tmp` if
you want to avoid changing normal developer tools. See `govulncheck.txt` and
`dependency-advisories.json` for the scan evidence from 2026-10-08.
