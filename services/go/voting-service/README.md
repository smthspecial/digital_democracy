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

## Implemented

Health contract (`/healthz`, `/readyz`) plus the full voting lifecycle,
in-memory only (no database yet -- see `store.go`):

- `POST /voting/sessions` -- create a vote session (`CreateSession`)
- `POST /voting/sessions/{id}/options` -- add an option, only while
  `status=scheduled`
- `GET /voting/sessions/{id}` -- read a session
- `POST /voting/sessions/{id}/open` -- DP-046 open trigger + DP-025 batch
  eligibility token issuance; returns the newly issued
  `{citizen_id, token_secret}` pairs (the one time a token secret exists in
  plaintext -- a real deployment delivers it out-of-band, not via this
  admin call)
- `POST /voting/sessions/{id}/close` -- DP-047 close trigger, chained
  synchronously into DP-026 tally computation and DP-027 certification (no
  message queue exists yet in this codebase to decouple them); returns the
  session plus its tally result
- `POST /voting/ballots` -- DP-016 cast ballot: atomically validates the
  eligibility token, encrypts the choice, writes the ballot (no
  `citizen_id`), and marks the token used
- `GET /voting/ballots/verify` -- DP-017 read-only inclusion check by
  verification code

Cryptography (ADR-019, stdlib only): AES-256-GCM per-ballot encryption
(`crypto.go`) and Shamir's Secret Sharing over GF(256) (`gf256.go`,
`shamir.go`) splitting each session's AES key into 5 key-holder shares
(3-of-5 threshold) -- the raw key is never persisted, only shares; it is
reconstructed via `Combine` whenever a ballot is cast or a session is
tallied. Tally algorithms for all four methods (`ranked_choice` via
Instant-Runoff, `approval`, `preference_score`, `comparative` via
Condorcet/Copeland) live in `tally.go`.

Two integration seams that depend on services not yet built
(delegation-service's DP-041 chain resolution, audit-service's
certification emission) are modeled as small injectable interfaces with
no-op defaults in `service.go`.
