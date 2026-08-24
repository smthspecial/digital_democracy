# voting-service

Go (ADR-019) — on the election-day concurrency and ballot-cryptography
critical path. Spec: [`.spec/technical/services/srv-008.md`](../../../.spec/technical/services/srv-008.md).
Route prefix `/voting` behind the gateway (ARCH-006). Runs on port 8080
in-container / 5001 in local dev (see root `README.md`). Stdlib only
(`net/http`) — no third-party dependencies, so `go build`/`go test` need
nothing beyond the Go toolchain itself.

```bash
go run .     # local dev server
go test ./... # unit tests
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business handlers are added alongside their data processes (`DP-016`,
`DP-025`, `DP-026`, ...) as they're built.
