# auth-service

Go (ADR-019) — SRV-017: Owns session lifecycle, MFA factor management,
and step-up authentication used by every other service. Spec: [`.spec/technical/services/srv-017.md`](../../../.spec/technical/services/srv-017.md).
Route prefix `/auth` behind the gateway (ARCH-006). Runs on port 8080
in-container / 5004 in local dev (see root `README.md`). Stdlib only
(`net/http`) — no third-party dependencies, so `go build`/`go test` need
nothing beyond the Go toolchain itself.

```bash
go run .     # local dev server
go test ./... # unit tests
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business handlers are added alongside their data processes as they're built (see .spec/technical/data-processes/ for this service's processes).
