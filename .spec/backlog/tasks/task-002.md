---
id: TASK-002
type: task
title: "Require verifiable credential proof before issuing a citizen session"
status: testing
storyId: US-001
priority: high
dependsOn: TASK-001
created: 2026-10-04
---

## Outcome

Login requires a verified passkey or other approved credential proof; knowing
a citizen identifier is never sufficient to obtain a session.

## Implemented flow

- A trusted verifier signs the identity outcome callback using a separate verifier key.
- A successful identity activation calls auth-service over the signed api-ts seam.
- Auth issues a five-minute single-use grant scoped to first-passkey enrollment.
- Registration and login use server-stored WebAuthn ceremonies in Postgres (memory in isolated tests).
- Only a verified assertion issues a session. T3 expires after five minutes; validation and refresh recheck active identity status.
- Legacy MFA placeholders live only in `_test.go` fixtures; their HTTP endpoints reject calls.

## Remaining validation

- Migrated Postgres ceremony/persistence checks passed; validate a real browser/platform-authenticator ceremony next.
- Connect a government credential or assisted verification adapter to the trusted callback and its secure grant delivery.

See ADR-040 for the ownership and authorization boundaries.
