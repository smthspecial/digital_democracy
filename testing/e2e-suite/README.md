# e2e-suite

Cross-service E2E tests for flows that don't have a single natural "owning" TS
service to live inside (unlike, say, ARCH-012's problem→proposal flow, which
lives in `services/ts/proposal-service/src/e2e/` because proposal-service is
the TS side of that pair). This package exists for flows between two or more
Go services, or flows spanning enough services that no single one of them is
the obvious host.

Same conventions as every other service's `src/e2e/` directory (see
`services/ts/identity-service/src/e2e/harness.ts` for the canonical version
of `harness.ts`, duplicated here rather than shared — see that file's header
comment for why): every service under test is spawned as its own real
process (`tsx` for TS, a built binary for Go) on a fixed local port and
reached over real HTTP. Nothing here mocks another service's business logic.
Test file names and scenario ids (`HPn`/`ECn`) match the `.spec/technical/architecture/arch-NNN.md`
doc they cover, verbatim, so a failing test traces back to that doc directly.

Run with `pnpm test` from this directory (or `pnpm --filter @dd/e2e-suite test`
from the repo root).
