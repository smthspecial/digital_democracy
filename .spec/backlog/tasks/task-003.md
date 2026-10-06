---
id: TASK-003
type: task
title: "Restrict internal auth operations to authenticated service callers"
status: testing
storyId: US-057
priority: high
dependsOn: TASK-001
created: 2026-10-04
---

## Outcome

Session revocation rejects public callers and accepts only the authenticated
internal caller allowed by the current two-app topology. Expired-session purge
runs inside auth-service rather than through a public HTTP endpoint.

## Implementation notes

- `api-ts` signs the exact revocation request with HMAC-SHA256 using the
  deployment-owned `INTERNAL_SERVICE_SHARED_SECRET`.
- `api-go` accepts only `api-ts`, rejects stale signatures, and fails closed
  if the secret is not configured.
- The auth-service in-process scheduler performs DP-067 cleanup daily.
