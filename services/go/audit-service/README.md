# audit-service

Go (ADR-019) — Owns the append-only, hash-chained public audit log --
the highest write fan-in of any service. Spec: [`.spec/technical/services/srv-012.md`](../../../.spec/technical/services/srv-012.md).
Route prefix `/audit` behind the gateway (ARCH-006). Runs on port 8080
in-container / 5003 in local dev (see root `README.md`). The HTTP surface
itself is stdlib-only (`net/http`); the only third-party dependency is
`github.com/digital-democracy/packages/go/eventbus` (a thin NATS JetStream
wrapper, ADR-023) for the optional `audit.append` queue consumer below.

```bash
go run .     # local dev server
go test ./... # unit tests
```

## Implemented

In-memory only (no database yet) -- see `store.go`. All endpoints are under `/audit`:

- `POST /audit/log` / `GET /audit/log` (`?action_type=` filter) -- append and list the
  hash-chained audit log (DP-036). Appends dedupe by `idempotency_key`; out-of-order
  arrivals are buffered and auto-flushed once their predecessor lands (`store.go`'s
  `linkEntry`).
- `GET /audit/log/verify` -- walks the whole chain and reports the first entry (if any)
  whose recomputed hash/signature no longer matches what's stored.
- `POST /audit/rights` / `GET /audit/rights` -- constitutional rights substrate for
  reviews to check against.
- `POST /audit/proposals/{id}/constitutional-review` -- DP-034: reviews a proposal
  against every protected right, writing one `constitutional_review` row (and one
  audit log entry) per right. Uses a placeholder `RightImpactAssessor` (case-insensitive
  keyword match); real constitutional review is an elevated human process (AUTH-007).
- `POST /audit/protocol-changes/gate` -- DP-043: releases a protocol change's execution
  signal once all required approvals, the delay, and public visibility are satisfied.

Hash-chain cryptography (`chain.go`): `payload_hash` = sha256 of the JSON payload;
each row's hash is derived (not stored) from its own fields chained to the previous
row's hash; `signature` = HMAC-SHA256 of the row hash under a process-local signing key
generated at startup (a real deployment would use an asymmetric key or KMS).

## Queue consumer (`nats.go`, ADR-023)

When `NATS_URL` is set, this service also consumes the `audit.append` queue
(DP-036, ARCH-005) via a durable JetStream consumer (`audit-service-append`,
`max_ack_pending: 1` so entries are appended strictly in delivery order) and
calls the same `Service.Append` the HTTP endpoint uses. Publishers no longer
need a live synchronous HTTP round trip just to get an event durably queued
-- a downed audit-service no longer means a lost audit event, since
JetStream retains the message until this consumer is back up. A message
that fails to unmarshal or fails `Service.Append`'s validation is logged and
dropped (acked, not nak'd) rather than redelivered forever -- those are
content-validation failures, not transient infra failures, so retrying
can never make them succeed. Unset -> the service runs exactly as before,
with only the synchronous endpoint.
