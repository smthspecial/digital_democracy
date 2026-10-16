---
id: TASK-015
type: task
title: "Prepare restricted credentials backups and trustworthy audit history"
status: in-progress
storyId: US-057
priority: high
dependsOn: TASK-006,TASK-013,TASK-014
linkedIds: REL-002,ADR-041,BUG-006,BUG-013,NFR-015,US-053
created: 2026-10-08
---

## Outcome

Existing storage and runtime Secrets meet the same restrictions proven on fresh disposable storage, with recoverable trusted history.

## Responsible role

Database/platform engineer and audit owner. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Inventory existing roles/ownership and migrate to separate restricted app logins, per-database CONNECT isolation and independent migration credentials. Test RLS, no runtime DDL, append-only audit and cross-database denial.
- [ ] Generate independent environment credentials; deliver runtime secrets without migration/admin URLs. Define service-signing and identity-verifier secret rotation compatible with the coordinated release.
- [ ] Preserve the stable audit seed and pin its public key. Independently establish provenance of old audit history; quarantine unverifiable placeholder signatures without silently re-signing them.
- [ ] Take encrypted backups of both databases and necessary signing metadata. Perform a restore drill and verify audit chains, credential spending, sessions and retained replay rows.
- [ ] Document rollback/checkpoints and access holders. Trustee key-share recovery remains independent of the platform backup domain; national recovery claims require US-053 evidence.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.

## Implementation checkpoint — 2026-10-08

See [implementation evidence](../../../testing/production-readiness/README.md)
for executed controls and the remaining acceptance gates. Local fixture results
do not qualify a production target.
