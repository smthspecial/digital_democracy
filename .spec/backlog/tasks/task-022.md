---
id: TASK-022
type: task
title: "Provide repeatable synthetic local seed users and reset tooling"
status: done
storyId: US-001
priority: high
linkedIds: REL-001,REL-002,TASK-002,BUG-020
created: 2026-10-16
---

## Outcome

The solo local development stack can be rebuilt from migrations and deterministic
synthetic fixtures. Requirements and production voting gates remain unchanged.

## Implementation

- `infra/compose/seed.py seed` starts/migrates the local stack and inserts missing
  fixture rows with deterministic IDs. It preserves edited rows and real passkeys.
- `reset` explicitly deletes only the fixed `dd-local` Compose project's volumes,
  recreates schemas and broker state, then seeds both databases. `.env.local` stays.
- Twenty-two synthetic citizens cover eligible, unverified/recent/outside residency,
  pending/rejected/inactive/revoked identity, suspended citizenship, all six governance
  role types, and two active competency domains.
- Fixtures include jurisdictions, problems, lifecycle-stage proposals, funding,
  expert analysis, civic assignments, participation, projects/milestones and public
  ledger data. Go fixtures contain a scheduled session, alternatives and rights.
- No fabricated passkeys, sessions, ballots, certified results or audit signatures.
  `enroll` uses the trusted local reviewer adapter to obtain a normal expiring grant.

## Verification

See [commands and account scenarios](../../../infra/compose/SEEDS.md) and
[retained test evidence](../../../testing/production-readiness/seed-results.json).
Unit tests cover reset ordering and failure behavior. Real migrated disposable
databases verify all inserts, repeatability, preservation of edited fixtures,
and positive/negative eligibility scenarios. The actual `dd-local` volume purge
is not executed as part of these tests.

This completes test-data tooling only. Browser journey qualification, identity
provider/recovery integration and complete production ballot cryptography are
separate unfinished work.
