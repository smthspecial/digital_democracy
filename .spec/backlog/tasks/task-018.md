---
id: TASK-018
type: task
title: "Automate isolated migrations and coordinated runtime deployment"
status: testing
storyId: US-057
priority: high
dependsOn: TASK-011,TASK-013,TASK-014,TASK-015,TASK-017
linkedIds: REL-002,ADR-041,TASK-003,BUG-014,BUG-019,BUG-020
created: 2026-10-08
---

## Outcome

One release procedure deploys compatible schemas, APIs, verifiers and clients without exposing privileged credentials or mixed signing formats.

## Responsible role

Release/platform engineer. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Create explicit Go MIGRATE_ONLY and Prisma migration Jobs with separate temporary privileged credentials. Gate runtime rollout on successful migrations and revoke/dispose of the jobs credentials afterward.
- [ ] Handle ArgoCD ordering/health gates explicitly; independently synced applications are not a coordinated release. Tag manifests and compatible verifier/client versions with one release identity.
- [ ] Quiesce affected mutations for the incompatible ADR-041 signing cutover or implement a reviewed bounded migration mechanism; do not reopen unsigned/old replay-prone requests.
- [ ] Check readiness, inter-service authorization, schema compatibility, stable audit key, persistent replay and ballot-component health before reopening traffic.
- [ ] Rehearse failed migration, partial rollout, interrupted job and application rollback. Use a verified restore/forward-fix plan for irreversible data changes; image rollback alone must not claim database rollback.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.

## Implementation checkpoint — 2026-10-08

See [implementation evidence](../../../testing/production-readiness/README.md)
for executed controls and the remaining acceptance gates. Local fixture results
do not qualify a production target.

## Local implementation — 2026-10-10

BUG-020 adds a Compose launcher for the selected solo local development scope:
separate Go/Prisma migration jobs precede the shared API startup. Existing
production Job/cutover/recovery acceptance criteria remain open; local success
does not close them.
