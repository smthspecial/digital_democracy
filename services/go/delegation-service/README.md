# delegation-service

Go (ADR-019) — Owns liquid-democracy delegation creation, revocation, and
chain resolution feeding the voting pipeline. Spec: [`.spec/technical/services/srv-010.md`](../../../.spec/technical/services/srv-010.md).
Route prefix `/delegation` behind the gateway (ARCH-006). Runs on port 8080
in-container / 5002 in local dev (see root `README.md`). Stdlib only
(`net/http`) — no third-party dependencies, so `go build`/`go test` need
nothing beyond the Go toolchain itself.

```bash
go run .     # local dev server
go test ./... # unit tests
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business handlers are added alongside their data processes as they're built (see .spec/technical/data-processes/ for this service's processes).
