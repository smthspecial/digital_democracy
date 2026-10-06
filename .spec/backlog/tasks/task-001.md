---
id: TASK-001
type: task
title: "Validate bearer sessions in api-ts instead of caller-controlled citizen headers"
status: testing
storyId: US-001
priority: high
created: 2026-10-04
---

## Outcome

`api-ts` derives the acting citizen and assurance tier from a bearer token
validated by `api-go` auth-service. Controller tests use a separate
bearer-token auth-service adapter rather than a second identity mechanism.

## Acceptance Criteria

- A valid bearer token supplies citizen context to protected controllers.
- Missing or invalid bearer tokens produce 401.
- Production requests never derive identity from `x-citizen-id`.
- Unit tests cover the auth boundary.
