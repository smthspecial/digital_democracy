---
id: TASK-017
type: task
title: "Add reproducible image scanning to the release gate"
status: testing
storyId: US-057
priority: high
dependsOn: TASK-006
linkedIds: REL-002,BUG-012,NFR-007,BUG-015
created: 2026-10-08
---

## Outcome

The exact deployable images are scanned and identified before release.

## Responsible role

CI/platform engineer. Named owner is assigned in TASK-006.

## Acceptance Criteria

- [ ] Build api-go, api-ts, web and any new ballot component from the frozen lockfile/patch set; pin release image digests and record component/base-image versions.
- [ ] Add a maintained image vulnerability scanner to CI. Fail on unmitigated critical/high findings; require documented review for lower severity and narrowly justified exceptions.
- [ ] Verify local source secrets are excluded, images run non-root, and no production fixture or cryptographic bypass is packaged.
- [ ] Retain raw dependency/Go/image scan reports with scanner/database timestamps and immutable image digests. Scanner failure cannot masquerade as a passing scan.
- [ ] Trigger scheduled rescans and review base-image updates; publish remediation tickets for new findings.

## Verification

Retain reproducible, sanitized evidence under `testing/production-readiness/`
when executing. Link results from [REL-002](../../planning/releases/rel-002.md)
and [TP-017](../../technical/test-plans/tp-017.md). This ticket is planned work;
the earlier remediation results do not satisfy these new acceptance criteria.

## Implementation checkpoint — 2026-10-08

See [implementation evidence](../../../testing/production-readiness/README.md)
for executed controls and the remaining acceptance gates. Local fixture results
do not qualify a production target.
