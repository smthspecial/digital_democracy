# audit-service

Go (ADR-019) — Owns the append-only, hash-chained public audit log --
the highest write fan-in of any service. Spec: [`.spec/technical/services/srv-012.md`](../../../.spec/technical/services/srv-012.md).
Route prefix `/audit` behind the gateway (ARCH-006). Runs on port 8080
in-container / 5003 in local dev (see root `README.md`). Stdlib only
(`net/http`) — no third-party dependencies, so `go build`/`go test` need
nothing beyond the Go toolchain itself.

```bash
go run .     # local dev server
go test ./... # unit tests
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business handlers are added alongside their data processes as they're built (see .spec/technical/data-processes/ for this service's processes).
