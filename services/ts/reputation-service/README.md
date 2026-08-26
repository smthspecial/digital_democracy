# reputation-service

TypeScript (ADR-019). Owns participation reputation scoring, tracked
separately from voting weight. Spec: [`.spec/technical/services/srv-014.md`](../../../.spec/technical/services/srv-014.md).
Route prefix `/reputation` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4011 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/reputation-service dev    # local dev server (tsx watch)
pnpm --filter @dd/reputation-service test   # vitest
```

Implements the health contract (`/healthz`, `/readyz`) plus SRV-014's
reputation event log (DP-038, in-memory):

- `POST /reputation/records` -- append a signed reputation delta for a
  citizen. Rejects a delta whose sign doesn't match its `factor_type`'s
  polarity (positive factors: `accurate_prediction`, `constructive`,
  `disclosure`, `successful_proposal`; negative factors:
  `misinformation`, `undisclosed_conflict`, `manipulation`, `fraud`), and
  rejects a negative-polarity record with no `source_ref` (the upstream
  authoritative decision that produced it). On a significant delta
  (`abs(delta) >= 10`) a `NotificationEmitter` fires; an `AuditEmitter`
  always fires. Both are injectable seams with no-op defaults, since
  notification-service and audit-service aren't called over the network
  here.
- `GET /reputation/citizens/:id` -- `{ citizen_id, total, records }`,
  where `total` is the sum of all `delta`s for that citizen.
- `GET /reputation/citizens/:id/records` -- the full event log for that
  citizen.

Reputation is purely informational -- it never affects voting weight,
competency status, or assignment priority, and nothing in this service
reads it to gate another action.
