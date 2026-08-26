# notification-service

TypeScript (ADR-019). Owns multi-channel (email, push, in-app) notification
dispatch. Spec: [`.spec/technical/services/srv-015.md`](../../../.spec/technical/services/srv-015.md).
Route prefix `/notifications` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4012 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/notification-service dev    # local dev server (tsx watch)
pnpm --filter @dd/notification-service test   # vitest
```

Implements DP-039 (notification dispatch) in-memory, alongside the health
contract (`/healthz`, `/readyz`):

- `POST /notifications/dispatch` -- dispatch a notification to a citizen over
  one channel (`email`, `push`, `in_app`). Rejects (400) any payload
  containing a banned private-data key (`ballot_choice`, `legal_identity`,
  `government_id`, `legal_identity_hash`, `raw_legal_identifier`), checked
  recursively. If the citizen has disabled the channel the notification is
  recorded `skipped` without calling any provider; otherwise delivery is
  attempted and retried (up to 3 total attempts) before being marked
  `failed`. Always responds 202, even when the downstream provider fails --
  delivery is best-effort and never surfaces as an HTTP error.
- `POST /notifications/:id/retry` -- manually re-attempt a notification stuck
  in `retrying`; a no-op once it has reached `failed` (or any other terminal
  status).
- `PUT /notifications/preferences/:citizenId` -- set a citizen's per-channel
  delivery preference, either `{ channel, enabled }` or a partial
  channel-\>enabled map. A channel with no stored preference defaults to
  enabled.
- `GET /notifications/citizens/:id` -- a citizen's notification records
  (in-app inbox use case), newest first.

Email/push/in-app delivery are modeled as injectable provider seams
(`src/services/providers.ts`) defaulting to always-succeed fakes, since the
real providers don't exist in this codebase yet.
